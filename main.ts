// t-bias — Deno Desktop entrypoint + dev web server.
//
// Serves the built SolidJS SPA (dist/) and the backend bridge:
//   GET /api/ping — HTTP round-trip proof
//   WS  /ws       — echo now; PTY output stream (Rust sidecar) in Phase 1
//
// Runs two ways:
//   deno run -A --watch main.ts   → plain web server, open in a browser (fast dev)
//   deno desktop main.ts          → bundles a native .app (laufey webview backend)
//
// The BrowserWindow block is guarded so the same file works in both contexts.

import { join } from "jsr:@std/path";
import { appDataDir } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { recordShellExit, recordShellSpawn } from "./db/shells.ts";
import { loadWorkspace, saveWorkspace } from "./db/workspace.ts";
import { listDirectory, readTextFile } from "./fs/sandbox.ts";
import { PtyBridge } from "./pty_bridge.ts";

// Startup logging: console + file. Helps debug packaged app launches where stdout
// is not visible.
const STARTUP_LOG = join(appDataDir(), "startup.log");
function logStartup(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(line.trimEnd());
  try {
    Deno.writeTextFileSync(STARTUP_LOG, line, { append: true });
  } catch {
    // ignore logging failures
  }
}

// Run migrations before serving.
try {
  migrate();
  logStartup("migrations complete");
} catch (e) {
  logStartup(`migration error: ${e}`);
  throw e;
}

// `deno desktop` relocates the compiled code to a temp dir, so import.meta.url
// can't locate dist/. Anchor to the working directory instead (the project dir
// under --hmr; the bundle dir once packaging is solved in Phase 5).
const DIST = join(Deno.cwd(), "dist");
// Under `deno desktop` the runtime auto-assigns the port and points the webview
// at it, so we only pin a port for browser dev (PORT=4321 deno run main.ts).
const PORT_ENV = Deno.env.get("PORT");

// Rust PTY sidecar supervisor. Started on first use.
const bridge = new PtyBridge();

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  woff2: "font/woff2",
};

function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  try {
    const file = await Deno.readFile(join(DIST, rel));
    return new Response(file, { headers: { "content-type": contentType(rel) } });
  } catch {
    // SPA fallback: hand unknown paths to the client router.
    try {
      const html = await Deno.readFile(join(DIST, "index.html"));
      return new Response(html, {
        headers: { "content-type": CONTENT_TYPES.html },
      });
    } catch {
      return new Response(
        "No build found. Run `deno task build` first.",
        { status: 500 },
      );
    }
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/ping") {
    return Response.json({
      ok: true,
      runtime: `Deno ${Deno.version.deno}`,
      ts: Date.now(),
    });
  }

  if (url.pathname === "/api/workspace" && req.method === "GET") {
    const ws = await loadWorkspace();
    return Response.json(ws ?? null);
  }

  if (url.pathname === "/api/workspace/save" && req.method === "POST") {
    const body = await req.json();
    await saveWorkspace(body);
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/fs/list" && req.method === "GET") {
    const subpath = url.searchParams.get("path") ?? "";
    try {
      const entries = await listDirectory(subpath);
      return Response.json(entries);
    } catch (e) {
      const status = e instanceof Error && e.message === "path outside sandbox" ? 403 : 500;
      return new Response(`fs list failed: ${e}`, { status });
    }
  }

  if (url.pathname === "/api/fs/read" && req.method === "GET") {
    const subpath = url.searchParams.get("path") ?? "";
    try {
      const content = await readTextFile(subpath);
      return Response.json({ content });
    } catch (e) {
      const status = e instanceof Error && e.message === "path outside sandbox" ? 403 : 500;
      return new Response(`fs read failed: ${e}`, { status });
    }
  }

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => socket.send("ws bridge open ✓");
    socket.onmessage = (e) => socket.send(`echo: ${e.data}`);
    return response;
  }

  // PTY channel: one WebSocket per terminal pane, bridged to the Rust sidecar.
  if (url.pathname === "/pty") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const paneId = Number(url.searchParams.get("pane") ?? "1");
    const cols = Number(url.searchParams.get("cols") ?? "80");
    const rows = Number(url.searchParams.get("rows") ?? "24");
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const shell = url.searchParams.get("shell") ?? undefined;
    const command = shell || Deno.env.get("SHELL") || "/bin/zsh";
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = async () => {
      await bridge.start();
      bridge.attach(paneId, socket, {
        cols,
        rows,
        shell,
        cwd,
        callbacks: {
          onSpawn: (info) => {
            recordShellSpawn(paneId, info.pid, command, cwd).catch((e) =>
              logStartup(`recordShellSpawn error: ${e}`)
            );
          },
          onExit: (info) => {
            recordShellExit(paneId, info.code).catch((e) =>
              logStartup(`recordShellExit error: ${e}`)
            );
          },
        },
      });
    };
    return response;
  }

  return serveStatic(url.pathname);
}

try {
  Deno.serve(
    {
      ...(PORT_ENV ? { port: Number(PORT_ENV) } : {}),
      onListen: ({ hostname, port }) => {
        logStartup(`server listening on http://${hostname}:${port}`);
      },
    },
    handler,
  );
} catch (e) {
  logStartup(`server error: ${e}`);
  throw e;
}
// `deno desktop` auto-creates the window and navigates it to the served
// address — no explicit BrowserWindow needed.
