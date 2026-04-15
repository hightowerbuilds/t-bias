import { Parser } from "./Parser";
import { Screen } from "./Screen";
import { VirtualCanvas } from "./VirtualCanvas";
import type { Selection } from "./Selection";
import type { RenderState, TerminalModes } from "./IRenderer";

// ---------------------------------------------------------------------------
// TerminalCore — pure terminal logic, no DOM, no Canvas
// ---------------------------------------------------------------------------
// Owns the parser, screen, and virtual canvas. Can be tested headlessly.
// Knows nothing about rendering, input events, or the browser environment.

export class TerminalCore {
  private screen: Screen;
  private parser: Parser;
  readonly virtualCanvas: VirtualCanvas;

  cols: number;
  rows: number;

  // Callbacks
  onResponse?: (data: string) => void;
  onTitleChange?: (title: string) => void;
  onClipboard?: (text: string) => void;

  constructor(cols: number, rows: number, scrollbackLimit = 5000) {
    this.cols = cols;
    this.rows = rows;
    this.virtualCanvas = new VirtualCanvas(cols, rows, scrollbackLimit);
    this.screen = new Screen(cols, rows, this.virtualCanvas);
    this.screen.onResponse = (data) => this.onResponse?.(data);
    this.screen.onClipboard = (payload) => this.handleOsc52(payload);
    this.parser = new Parser(this.screen);
  }

  // =========================================================================
  // Data flow
  // =========================================================================

  /** Feed PTY output into the parser → screen state machine. */
  write(data: string): void {
    this.parser.feed(data);
    // Check for title changes
    if (this.screen.title !== this._lastTitle) {
      this._lastTitle = this.screen.title;
      this.onTitleChange?.(this.screen.title);
    }
  }
  private _lastTitle = "";

  /** Resize the terminal grid. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.virtualCanvas.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  // =========================================================================
  // OSC 52 clipboard
  // =========================================================================

  /** Handle OSC 52 clipboard sequence. Payload format: "Pc;Pd" */
  private handleOsc52(payload: string): void {
    const semi = payload.indexOf(";");
    if (semi < 0) return;
    const pd = payload.substring(semi + 1);

    if (pd === "?") {
      // Query — not supported (would need async clipboard read)
      return;
    }

    // Pd is base64-encoded text
    try {
      const text = atob(pd);
      this.onClipboard?.(text);
    } catch {
      // Invalid base64 — ignore
    }
  }

  // =========================================================================
  // Viewport
  // =========================================================================

  scrollViewport(delta: number): void {
    this.screen.scrollViewport(delta);
  }

  resetViewport(): void {
    this.screen.resetViewport();
  }

  // =========================================================================
  // Modes (read-only for the host)
  // =========================================================================

  get modes(): TerminalModes {
    return {
      applicationCursor: this.screen.applicationCursor,
      bracketedPaste: this.screen.bracketedPaste,
      mouseEnabled: this.screen.mouseEnabled,
      mouseSgr: this.screen.mouseSgr,
      mouseDrag: this.screen.mouseDrag,
      mouseAll: this.screen.mouseAll,
      isAlternateScreen: this.screen.isAlternateScreen,
      focusEvents: this.screen.focusEvents,
    };
  }

  get viewportOffset(): number {
    return this.screen.viewportOffset;
  }

  // =========================================================================
  // Selection text extraction
  // =========================================================================

  /** Extract text from the given selection bounds. */
  getSelectedText(selection: Selection): string {
    const r = selection.range;
    if (!r) return "";

    const lines: string[] = [];

    for (let row = r.startRow; row <= r.endRow; row++) {
      let line = "";
      const colStart = row === r.startRow ? r.startCol : 0;
      const colEnd = row === r.endRow ? r.endCol : this.cols - 1;

      for (let col = colStart; col <= colEnd; col++) {
        const cell = this.screen.getCell(row, col);
        line += cell.char || " ";
      }

      lines.push(line.trimEnd());
    }

    return lines.join("\n");
  }

  // =========================================================================
  // Render state snapshot
  // =========================================================================

  /** Build a RenderState snapshot for the text layer renderer. */
  getRenderState(): RenderState {
    const screen = this.screen;
    const vc = this.virtualCanvas;
    return {
      cols: this.cols,
      rows: this.rows,
      getCell: (row, col) => screen.getCell(row, col),
      viewportOffset: screen.viewportOffset,
      dirtyRows: vc.dirtyBitmap,
      chars: vc.activeChars,
      fg: vc.activeFg,
      bg: vc.activeBg,
      attrs: vc.activeAttrs,
      ulColor: vc.activeUlColor,
      getGrapheme: (idx) => vc.getGraphemeByIndex(idx),
      rowOffset: (row) => vc.rowOffset(row),
      dirtyColStart: vc.dirtyColStart,
      dirtyColEnd: vc.dirtyColEnd,
    };
  }

  /** Cursor state for the cursor layer. */
  get cursor() {
    return {
      x: this.screen.cursorX,
      y: this.screen.cursorY,
      visible: this.screen.cursorVisible,
      shape: this.screen.cursorShape,
    };
  }
}
