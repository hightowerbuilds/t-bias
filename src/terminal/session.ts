import { XtermHost } from "./XtermHost";

// A TerminalSession owns one pane's xterm host + its /pty WebSocket. Sessions
// live in a module-level cache keyed by paneId so that splitting/zooming (which
// remounts pane components) never drops terminal state or reconnects the shell.
// The pane component calls mountTerminal on mount and unmountTerminal (detach,
// not destroy) on cleanup; destroyTerminal is only called on real pane close.

export interface MountOptions {
  cwd?: string;
  onExit?: () => void;
}

class TerminalSession {
  readonly paneId: number;
  readonly host: XtermHost;
  #ws: WebSocket;
  #dataSub: { dispose: () => void };
  #ro: ResizeObserver;
  #container: HTMLElement;
  onExit?: () => void;

  constructor(paneId: number, container: HTMLElement, opts: MountOptions) {
    this.paneId = paneId;
    this.#container = container;
    this.onExit = opts.onExit;
    this.host = new XtermHost(container);
    const size = this.host.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({
      pane: String(paneId),
      cols: String(size.cols),
      rows: String(size.rows),
    });
    if (opts.cwd) q.set("cwd", opts.cwd);

    this.#ws = new WebSocket(`${proto}://${location.host}/pty?${q}`);
    this.#ws.binaryType = "arraybuffer";
    this.#ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.host.write(new Uint8Array(e.data));
    };
    this.#ws.onclose = () => this.onExit?.();

    this.#dataSub = this.host.onData((d) => {
      if (this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ t: "i", d }));
      }
    });

    this.#ro = new ResizeObserver(() => this.#sendResize());
    this.#ro.observe(container);
  }

  #sendResize(): void {
    const s = this.host.fit();
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: "r", c: s.cols, r: s.rows }));
    }
  }

  reattach(container: HTMLElement): void {
    this.#ro.disconnect();
    this.#container = container;
    this.host.reattach(container);
    this.#ro.observe(container);
    this.#sendResize();
  }

  detach(): void {
    this.#ro.disconnect();
    this.host.detach();
  }

  dispose(): void {
    this.#ro.disconnect();
    this.#dataSub.dispose();
    try {
      this.#ws.close();
    } catch { /* already closing */ }
    this.host.dispose();
  }
}

const sessions = new Map<number, TerminalSession>();

/** Mount (or reattach) the terminal for a pane into a container. */
export function mountTerminal(paneId: number, container: HTMLElement, opts: MountOptions): void {
  const existing = sessions.get(paneId);
  if (existing) {
    existing.onExit = opts.onExit;
    existing.reattach(container);
    return;
  }
  sessions.set(paneId, new TerminalSession(paneId, container, opts));
}

/** Detach a pane's terminal (component unmounting) without killing the shell. */
export function unmountTerminal(paneId: number): void {
  sessions.get(paneId)?.detach();
}

/** Destroy a pane's terminal — closes the WebSocket, which tells the sidecar to
 *  terminate the shell. Called on real pane/tab close. */
export function destroyTerminal(paneId: number): void {
  const s = sessions.get(paneId);
  if (s) {
    s.dispose();
    sessions.delete(paneId);
  }
}

export function focusTerminal(paneId: number): void {
  sessions.get(paneId)?.host.focus();
}

export function zoomTerminal(paneId: number, delta: number): void {
  sessions.get(paneId)?.host.zoom(delta);
}

export function resetTerminalZoom(paneId: number): void {
  sessions.get(paneId)?.host.resetZoom();
}
