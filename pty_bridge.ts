// Supervises the Rust PTY sidecar and bridges it to per-pane WebSockets.
//
//   webview <--WS /pty?pane=N--> PtyBridge <--stdio NDJSON--> tbias-pty (sidecar)
//
// webview -> Deno (WS text/JSON): {"t":"i","d":<string>}  input
//                                 {"t":"r","c":cols,"r":rows}  resize
// Deno -> webview (WS binary):    raw PTY output bytes (xterm writes Uint8Array)

import { TextLineStream } from "jsr:@std/streams/text-line-stream";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";
import { dirname, join } from "jsr:@std/path";

// Resolve the Rust sidecar binary. Order:
// 1. TBIAS_PTY env override (dev / custom installs)
// 2. project dev build (cwd/sidecar/target/release/tbias-pty)
// 3. packaged .app: next to the executable (Contents/MacOS/tbias-pty)
// 4. packaged .app: in Resources/sidecar/tbias-pty
async function resolveSidecarBin(): Promise<string> {
  const env = Deno.env.get("TBIAS_PTY");
  if (env) return env;

  const candidates = [
    join(Deno.cwd(), "sidecar", "target", "release", "tbias-pty"),
    join(dirname(Deno.execPath()), "tbias-pty"),
    join(dirname(Deno.execPath()), "..", "Resources", "sidecar", "tbias-pty"),
  ];

  for (const p of candidates) {
    try {
      const stat = await Deno.stat(p);
      if (stat.isFile) return p;
    } catch { /* not found */ }
  }

  return candidates[0];
}

interface Frame {
  type: string;
  paneId?: number;
  data?: string;
  message?: string;
  pid?: number;
  command?: string;
  cwd?: string;
  code?: number;
  success?: boolean;
}

export interface ShellInfo {
  pid?: number;
  command?: string;
  cwd?: string;
}

export interface ExitInfo {
  code?: number;
  success: boolean;
}

export interface AttachCallbacks {
  onSpawn?: (info: ShellInfo) => void;
  onExit?: (info: ExitInfo) => void;
}

export interface AttachOptions {
  cols: number;
  rows: number;
  shell?: string;
  cwd?: string;
  callbacks?: AttachCallbacks;
}

export class PtyBridge {
  #child?: Deno.ChildProcess;
  #stdin?: WritableStreamDefaultWriter<Uint8Array>;
  #sockets = new Map<number, WebSocket>();
  #callbacks = new Map<number, AttachCallbacks>();
  #enc = new TextEncoder();
  #started = false;
  #sidecarBin?: string;

  /** Spawn the sidecar and begin pumping its stdout/stderr. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    this.#sidecarBin = await resolveSidecarBin();
    console.log(`[pty] using sidecar: ${this.#sidecarBin}`);
    const command = new Deno.Command(this.#sidecarBin, {
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    this.#child = command.spawn();
    this.#stdin = this.#child.stdin.getWriter();

    this.#pumpStdout();
    this.#pumpStderr();

    // Terminate the sidecar (and thus all PTY children) when Deno exits.
    globalThis.addEventListener("unload", () => this.shutdown());
  }

  #sendToSidecar(obj: unknown): void {
    this.#stdin?.write(this.#enc.encode(JSON.stringify(obj) + "\n")).catch(() => {});
  }

  async #pumpStdout(): Promise<void> {
    if (!this.#child) return;
    const lines = this.#child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      if (!line.trim()) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handleFrame(frame);
    }
  }

  async #pumpStderr(): Promise<void> {
    if (!this.#child) return;
    const lines = this.#child.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      if (line.trim()) console.error(`[sidecar] ${line}`);
    }
  }

  #handleFrame(frame: Frame): void {
    if (frame.paneId == null) return;
    const ws = this.#sockets.get(frame.paneId);

    switch (frame.type) {
      case "output": {
        if (frame.data != null && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(decodeBase64(frame.data)); // binary frame
        }
        break;
      }
      case "spawned": {
        this.#callbacks.get(frame.paneId)?.onSpawn?.({
          pid: frame.pid,
          command: frame.command,
          cwd: frame.cwd,
        });
        break;
      }
      case "exit": {
        this.#callbacks.get(frame.paneId)?.onExit?.({
          code: frame.code,
          success: frame.success ?? false,
        });
        ws?.close(1000, "shell-exit");
        this.#sockets.delete(frame.paneId);
        this.#callbacks.delete(frame.paneId);
        break;
      }
      case "error": {
        console.error(`[sidecar] pane ${frame.paneId}: ${frame.message}`);
        ws?.close(1011, "sidecar-error");
        this.#sockets.delete(frame.paneId);
        this.#callbacks.delete(frame.paneId);
        break;
      }
    }
  }

  /** Bind a freshly-opened WebSocket to a pane and spawn its shell. */
  attach(paneId: number, ws: WebSocket, opts: AttachOptions): void {
    this.#sockets.set(paneId, ws);
    if (opts.callbacks) this.#callbacks.set(paneId, opts.callbacks);
    ws.binaryType = "arraybuffer";

    this.#sendToSidecar({
      type: "spawn",
      paneId,
      cols: opts.cols,
      rows: opts.rows,
      shell: opts.shell,
      cwd: opts.cwd,
    });

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let m: { t?: string; d?: string; c?: number; r?: number };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "i" && typeof m.d === "string") {
        this.#sendToSidecar({
          type: "input",
          paneId,
          data: encodeBase64(this.#enc.encode(m.d)),
        });
      } else if (m.t === "r") {
        this.#sendToSidecar({ type: "resize", paneId, cols: m.c, rows: m.r });
      }
    };

    ws.onclose = () => {
      if (this.#sockets.get(paneId) === ws) {
        this.#sockets.delete(paneId);
        this.#sendToSidecar({ type: "close", paneId });
      }
    };
  }

  shutdown(): void {
    try {
      this.#stdin?.close();
    } catch { /* already closing */ }
    try {
      this.#child?.kill("SIGTERM");
    } catch { /* already gone */ }
  }
}
