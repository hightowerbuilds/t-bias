import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

// Lean xterm.js wrapper. Phase 2 will grow this (search, themes, host cache);
// for Phase 1 it just needs to render, size, and shuttle bytes.
const DEFAULT_FONT_SIZE = 13;

export class XtermHost {
  readonly term: Terminal;
  #fit: FitAddon;

  constructor(container: HTMLElement) {
    this.term = new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: DEFAULT_FONT_SIZE,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: "#0d1117", foreground: "#e6edf3" },
    });

    this.#fit = new FitAddon();
    this.term.loadAddon(this.#fit);
    this.term.loadAddon(new WebLinksAddon());

    const unicode11 = new Unicode11Addon();
    this.term.loadAddon(unicode11);
    this.term.unicode.activeVersion = "11";

    this.term.open(container);
    try {
      this.term.loadAddon(new WebglAddon());
    } catch {
      // Canvas/DOM fallback is fine.
    }
    this.#fit.fit();
  }

  /** Refit to the container and return the new grid size. */
  fit(): { cols: number; rows: number } {
    try {
      this.#fit.fit();
    } catch {
      // container not laid out yet
    }
    return { cols: this.term.cols, rows: this.term.rows };
  }

  write(data: Uint8Array): void {
    this.term.write(data);
  }

  onData(cb: (data: string) => void) {
    return this.term.onData(cb);
  }

  focus(): void {
    this.term.focus();
  }

  /** Detach the terminal's DOM element without destroying state. Used when a
   *  pane component unmounts during a split/tree restructure. */
  detach(): void {
    const el = this.term.element;
    el?.parentElement?.removeChild(el);
  }

  /** Reparent the preserved terminal element into a new container. */
  reattach(container: HTMLElement): void {
    const el = this.term.element;
    if (el) container.appendChild(el);
    this.fit();
  }

  zoom(delta: number): void {
    const current = this.term.options.fontSize ?? DEFAULT_FONT_SIZE;
    this.term.options.fontSize = Math.max(8, Math.min(32, current + delta));
    this.fit();
  }

  resetZoom(): void {
    this.term.options.fontSize = DEFAULT_FONT_SIZE;
    this.fit();
  }

  dispose(): void {
    this.term.dispose();
  }
}
