// Supervises the Rust PTY sidecar and bridges it to per-pane WebSockets.
//
//   webview <--WS /pty?pane=N--> PtyBridge <--stdio NDJSON--> tbias-pty (sidecar)
//
// webview -> Deno (WS text/JSON): {"t":"i","d":<string>}  input
//                                 {"t":"r","c":cols,"r":rows}  resize
// Deno -> webview (WS binary):    raw PTY output bytes (xterm writes Uint8Array)

import { TextLineStream } from "jsr:@std/streams/text-line-stream";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";

const SIDECAR_BIN = new URL(
  "./sidecar/target/release/tbias-pty",
  import.meta.url,
);

interface Frame {
  type: string;
  paneId?: number;
  data?: string;
  message?: string;
}

export interface AttachOptions {
  cols: number;
  rows: number;
  shell?: string;
  cwd?: string;
}

export class PtyBridge {
  #child?: Deno.ChildProcess;
  #stdin?: WritableStreamDefaultWriter<Uint8Array>;
  #sockets = new Map<number, WebSocket>();
  #enc = new TextEncoder();
  #started = false;

  /** Spawn the sidecar and begin pumping its stdout/stderr. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    const command = new Deno.Command(SIDECAR_BIN, {
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
      case "exit": {
        ws?.close(1000, "shell-exit");
        this.#sockets.delete(frame.paneId);
        break;
      }
      case "error": {
        console.error(`[sidecar] pane ${frame.paneId}: ${frame.message}`);
        ws?.close(1011, "sidecar-error");
        this.#sockets.delete(frame.paneId);
        break;
      }
    }
  }

  /** Bind a freshly-opened WebSocket to a pane and spawn its shell. */
  attach(paneId: number, ws: WebSocket, opts: AttachOptions): void {
    this.#sockets.set(paneId, ws);
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
