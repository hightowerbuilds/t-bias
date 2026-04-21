import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ITheme } from "@xterm/xterm";

export interface XtermHostOptions {
  fontSize?: number;
  fontFamily?: string;
  scrollbackLimit?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  padding?: number;
  theme?: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBg: string;
    ansi: string[];
  };
}

export class XtermHost {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private container: HTMLDivElement | null = null;
  private disposed = false;
  private defaultFontSize: number;

  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;
  onCwdChange?: (cwd: string) => void;

  constructor(container: HTMLDivElement, options: XtermHostOptions = {}) {
    this.container = container;
    this.defaultFontSize = options.fontSize ?? 14;

    const theme = options.theme ? this.mapTheme(options.theme) : undefined;

    this.terminal = new Terminal({
      fontSize: options.fontSize ?? 14,
      fontFamily: options.fontFamily ?? "Menlo, Monaco, 'Courier New', monospace",
      scrollback: options.scrollbackLimit ?? 5000,
      cursorStyle: options.cursorStyle ?? "block",
      cursorBlink: options.cursorBlink ?? true,
      theme,
      allowProposedApi: true,
      convertEol: false,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    // Unicode 11 for proper emoji/CJK/wide character handling
    const unicode11 = new Unicode11Addon();
    this.terminal.loadAddon(unicode11);
    this.terminal.unicode.activeVersion = "11";

    this.terminal.open(container);

    // Try WebGL renderer for best performance, fall back silently
    try {
      this.terminal.loadAddon(new WebglAddon());
    } catch {
      // Canvas/DOM fallback is fine
    }

    // Wire callbacks
    this.terminal.onData((data) => this.onData?.(data));
    this.terminal.onResize(({ cols, rows }) => this.onResize?.(cols, rows));
    this.terminal.onTitleChange((title) => this.onTitleChange?.(title));

    // OSC 7 — working directory tracking
    this.terminal.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        this.onCwdChange?.(decodeURIComponent(url.pathname));
      } catch {
        // Some shells send just the path without file:// prefix
        if (data.startsWith("/")) {
          this.onCwdChange?.(data);
        }
      }
      return true;
    });

    // Ensure xterm fills container with no visible gaps or borders
    const bg = options.theme?.background ?? "#000";
    const el = this.terminal.element;
    if (el) {
      el.style.height = "100%";
      el.style.background = bg;
      if (options.padding && options.padding > 0) {
        el.style.padding = `${options.padding}px`;
      }
    }

    // Inject styles to hide scrollbar gap and fix viewport background
    const style = document.createElement("style");
    style.textContent = `
      .xterm-viewport { background-color: ${bg} !important; }
      .xterm-viewport::-webkit-scrollbar { width: 8px; background: ${bg}; }
      .xterm-viewport::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
      .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #555; }
    `;
    container.appendChild(style);

    this.fitAddon.fit();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  write(data: string) {
    if (!this.disposed) this.terminal.write(data);
  }

  fit() {
    if (!this.disposed) {
      try { this.fitAddon.fit(); } catch {}
    }
  }

  focus() {
    if (!this.disposed) this.terminal.focus();
  }

  dispose() {
    this.disposed = true;
    this.terminal.dispose();
  }

  /** Detach from DOM for pane remounting. Preserves terminal state. */
  detach() {
    this.disposed = true;
    // Terminal.element stays in memory — we'll reparent it on reattach
  }

  /** Reattach to a new container after a pane tree restructure. */
  reattach(newContainer: HTMLDivElement) {
    this.container = newContainer;
    this.disposed = false;
    const el = this.terminal.element;
    if (el) {
      newContainer.appendChild(el);
      this.fitAddon.fit();
    }
  }

  // Search
  search(query: string, options?: { regex?: boolean; caseSensitive?: boolean }) {
    this.searchAddon.findNext(query, {
      regex: options?.regex,
      caseSensitive: options?.caseSensitive,
    });
  }

  searchNext(query: string, options?: { regex?: boolean; caseSensitive?: boolean }) {
    this.searchAddon.findNext(query, {
      regex: options?.regex,
      caseSensitive: options?.caseSensitive,
    });
  }

  searchPrev(query: string, options?: { regex?: boolean; caseSensitive?: boolean }) {
    this.searchAddon.findPrevious(query, {
      regex: options?.regex,
      caseSensitive: options?.caseSensitive,
    });
  }

  clearSearch() {
    this.searchAddon.clearDecorations();
  }

  get gridSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  zoom(delta: number) {
    const current = this.terminal.options.fontSize ?? 14;
    const next = Math.max(8, Math.min(32, current + delta));
    this.terminal.options.fontSize = next;
    this.fitAddon.fit();
  }

  resetZoom() {
    this.terminal.options.fontSize = this.defaultFontSize;
    this.fitAddon.fit();
  }

  // ---------------------------------------------------------------------------
  // Theme mapping
  // ---------------------------------------------------------------------------

  private mapTheme(t: NonNullable<XtermHostOptions["theme"]>): ITheme {
    return {
      background: t.background,
      foreground: t.foreground,
      cursor: t.cursor,
      selectionBackground: t.selectionBg,
      black: t.ansi[0],
      red: t.ansi[1],
      green: t.ansi[2],
      yellow: t.ansi[3],
      blue: t.ansi[4],
      magenta: t.ansi[5],
      cyan: t.ansi[6],
      white: t.ansi[7],
      brightBlack: t.ansi[8],
      brightRed: t.ansi[9],
      brightGreen: t.ansi[10],
      brightYellow: t.ansi[11],
      brightBlue: t.ansi[12],
      brightMagenta: t.ansi[13],
      brightCyan: t.ansi[14],
      brightWhite: t.ansi[15],
    };
  }
}
