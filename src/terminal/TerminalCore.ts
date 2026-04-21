import { Parser } from "./Parser";
import { Screen } from "./Screen";
import { VirtualCanvas, MARK_A, MARK_B, MARK_C, MARK_D_UNKNOWN, MARK_D_SUCCESS, MARK_D_FAILURE } from "./VirtualCanvas";
import type { Selection } from "./Selection";
import type { RenderState, TerminalModes } from "./IRenderer";
import { WIDE } from "./types";

/** A single search hit, in unified buffer coordinates.
 *  absRow 0 = oldest scrollback row; absRow === scrollbackLength means screen row 0. */
export interface SearchMatch {
  absRow: number;
  col: number;
  len: number;
}

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
  onCwdChange?: (cwd: string) => void;
  onSyncModeChange?: (enabled: boolean) => void;

  constructor(cols: number, rows: number, scrollbackLimit = 5000) {
    this.cols = cols;
    this.rows = rows;
    this.virtualCanvas = new VirtualCanvas(cols, rows, scrollbackLimit);
    this.screen = new Screen(cols, rows, this.virtualCanvas);
    this.screen.onResponse = (data) => this.onResponse?.(data);
    this.screen.onClipboard = (payload) => this.handleOsc52(payload);
    this.screen.onShellIntegration = (mark, param) => this.handleShellIntegration(mark, param);
    this.screen.onCwd = (uri) => this.handleCwd(uri);
    this.screen.onSyncModeChange = (enabled) => this.onSyncModeChange?.(enabled);
    this.parser = new Parser(this.screen);
  }

  /** Parse OSC 7 URI (file://hostname/path) and fire onCwdChange. */
  private handleCwd(uri: string): void {
    try {
      const url = new URL(uri);
      const path = decodeURIComponent(url.pathname);
      if (path) this.onCwdChange?.(path);
    } catch {
      // Bare path (no file:// prefix) — use as-is
      if (uri.startsWith("/")) this.onCwdChange?.(uri);
    }
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
    const colsChanged = cols !== this.cols;
    this.cols = cols;
    this.rows = rows;
    // When cols change on the main screen, Screen.resize handles calling
    // vc.resize itself (it needs to read old content before the VC resizes).
    // Otherwise, resize the VC first.
    if (!colsChanged || this.screen.isAltScreen) {
      this.virtualCanvas.resize(cols, rows);
    }
    this.screen.resize(cols, rows);
  }

  // =========================================================================
  // OSC 52 clipboard
  // =========================================================================

  /** Handle OSC 52 clipboard sequence. Payload format: "Pc;Pd" */
  /** Callback to read clipboard text for OSC 52 query responses. */
  onClipboardRead?: () => Promise<string | null>;

  private handleOsc52(payload: string): void {
    const semi = payload.indexOf(";");
    if (semi < 0) return;
    const pc = payload.substring(0, semi); // selection: c, p, s, etc.
    const pd = payload.substring(semi + 1);

    if (pd === "?") {
      // Query — read clipboard and respond with base64-encoded content.
      if (this.onClipboardRead) {
        this.onClipboardRead().then((text) => {
          if (text != null) {
            const encoded = btoa(text);
            this.onResponse?.(`\x1b]52;${pc};${encoded}\x07`);
          }
        }).catch(() => {
          // Clipboard read failed — respond with empty payload.
          this.onResponse?.(`\x1b]52;${pc};\x07`);
        });
      }
      return;
    }

    // Pd is base64-encoded text — decode and pass to clipboard write callback.
    try {
      const text = atob(pd);
      this.onClipboard?.(text);
    } catch {
      // Invalid base64 — ignore
    }
  }

  // =========================================================================
  // Scrollback length (for search / viewport calculations)
  // =========================================================================

  get scrollbackLength(): number {
    return this.screen.scrollbackLength;
  }

  // =========================================================================
  // Search
  // =========================================================================

  /** Search the active buffer + scrollback for `query`.
   *  Returns matches sorted oldest-first (absRow ascending, col ascending).
   *  Not supported on the alt screen (returns []). */
  search(query: string, caseSensitive: boolean, isRegex: boolean): SearchMatch[] {
    if (!query || this.modes.isAlternateScreen) return [];

    let re: RegExp;
    try {
      const flags = "g" + (caseSensitive ? "" : "i");
      const pattern = isRegex
        ? query
        : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(pattern, flags);
    } catch {
      return [];
    }

    const matches: SearchMatch[] = [];
    const sbLen = this.screen.scrollbackLength;
    const vc = this.virtualCanvas;

    // Scrollback rows (absRow 0 = oldest)
    for (let sb = 0; sb < sbLen; sb++) {
      const rowText = vc.getScrollbackRowText(sb);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rowText)) !== null) {
        matches.push({ absRow: sb, col: m.index, len: m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    }

    // Active buffer rows (absRow = sbLen + screenRow)
    for (let r = 0; r < this.rows; r++) {
      const rowText = vc.getActiveRowText(r);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rowText)) !== null) {
        matches.push({ absRow: sbLen + r, col: m.index, len: m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    }

    return matches;
  }

  // =========================================================================
  // Shell integration (OSC 133)
  // =========================================================================

  private handleShellIntegration(mark: string, param?: string): void {
    const row = this.cursor.y;
    let markValue: number;
    switch (mark) {
      case "A": markValue = MARK_A; break;
      case "B": markValue = MARK_B; break;
      case "C": markValue = MARK_C; break;
      case "D": {
        if (!param) {
          markValue = MARK_D_UNKNOWN;
        } else {
          const code = parseInt(param, 10);
          markValue = isNaN(code) ? MARK_D_UNKNOWN : code === 0 ? MARK_D_SUCCESS : MARK_D_FAILURE;
        }
        break;
      }
      default: return;
    }
    this.virtualCanvas.setPromptMark(row, markValue);
  }

  /** Find the absRow of the nearest prompt-A mark strictly above the current viewport top.
   *  Returns -1 if none found. */
  findPrevPrompt(): number {
    const sbLen = this.screen.scrollbackLength;
    const viewportTop = sbLen - this.screen.viewportOffset;
    const vc = this.virtualCanvas;

    // Search backwards from one row above the top of the current viewport
    for (let abs = viewportTop - 1; abs >= 0; abs--) {
      if (abs < sbLen) {
        if (vc.getScrollbackPromptMark(abs) === MARK_A) return abs;
      } else {
        if (vc.getPromptMark(abs - sbLen) === MARK_A) return abs;
      }
    }
    return -1;
  }

  /** Find the absRow of the nearest prompt-A mark strictly below the current viewport bottom.
   *  Returns -1 if none found. */
  findNextPrompt(): number {
    const sbLen = this.screen.scrollbackLength;
    const viewportBottom = sbLen - this.screen.viewportOffset + this.rows;
    const vc = this.virtualCanvas;

    for (let abs = viewportBottom; abs < sbLen + this.rows; abs++) {
      if (abs < sbLen) {
        if (vc.getScrollbackPromptMark(abs) === MARK_A) return abs;
      } else {
        if (vc.getPromptMark(abs - sbLen) === MARK_A) return abs;
      }
    }
    return -1;
  }

  /** Scroll the viewport to place the given absRow at the top. */
  scrollToPrompt(absRow: number): void {
    const sbLen = this.screen.scrollbackLength;
    const targetOffset = Math.max(0, Math.min(sbLen, sbLen - absRow));
    this.scrollViewport(targetOffset - this.screen.viewportOffset);
  }

  /** Return visible prompt D marks (exit status indicators) for overlay rendering.
   *  Each entry has viewportRow (0-based) and whether the command succeeded. */
  getVisibleDMarks(): { viewportRow: number; success: boolean }[] {
    const sbLen = this.screen.scrollbackLength;
    const vOffset = this.screen.viewportOffset;
    const vc = this.virtualCanvas;
    const result: { viewportRow: number; success: boolean }[] = [];

    for (let vr = 0; vr < this.rows; vr++) {
      const abs = sbLen - vOffset + vr;
      let mark = 0;
      if (abs >= 0 && abs < sbLen) {
        mark = vc.getScrollbackPromptMark(abs);
      } else if (abs >= sbLen) {
        mark = vc.getPromptMark(abs - sbLen);
      }
      if (mark === MARK_D_SUCCESS) result.push({ viewportRow: vr, success: true });
      else if (mark === MARK_D_FAILURE) result.push({ viewportRow: vr, success: false });
    }
    return result;
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

  clearScrollback(): void {
    this.virtualCanvas.clearScrollback();
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
      alternateScroll: this.screen.alternateScroll,
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

      let skipNext = false;
      for (let col = colStart; col <= colEnd; col++) {
        if (skipNext) { skipNext = false; continue; }
        const cell = this.screen.getCell(row, col);
        if (cell.char) {
          line += cell.char;
          // Wide chars occupy 2 cells — skip the empty placeholder
          if (cell.attrs & WIDE) skipNext = true;
        } else {
          line += " ";
        }
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
    const vpOff = screen.viewportOffset;
    const sbLen = vc.scrollbackLength;

    // Viewport-aware row source resolver.
    // When viewportOffset > 0 (scrolled up), visible rows are a mix of
    // scrollback rows (at the top) and active screen rows (at the bottom).
    const getRowSource = (row: number): import("./IRenderer").RowSource => {
      if (vpOff > 0 && !screen.isAlternateScreen) {
        const scrollRow = sbLen - vpOff + row;
        if (scrollRow >= 0 && scrollRow < sbLen) {
          // This visible row comes from scrollback
          const offset = vc.scrollbackRowOffset(scrollRow);
          return {
            chars: vc.scrollbackChars,
            fg: vc.scrollbackFg,
            bg: vc.scrollbackBg,
            attrs: vc.scrollbackAttrs,
            ulColor: null,
            offset,
            getGrapheme: null,
          };
        }
        // Below scrollback — active screen row
        const bufRow = row - (vpOff - Math.min(vpOff, sbLen));
        if (bufRow >= 0 && bufRow < this.rows) {
          return {
            chars: vc.activeChars,
            fg: vc.activeFg,
            bg: vc.activeBg,
            attrs: vc.activeAttrs,
            ulColor: vc.activeUlColor,
            offset: vc.rowOffset(bufRow),
            getGrapheme: (idx) => vc.getGraphemeByIndex(idx),
          };
        }
      }
      // Not scrolled — direct active screen access
      return {
        chars: vc.activeChars,
        fg: vc.activeFg,
        bg: vc.activeBg,
        attrs: vc.activeAttrs,
        ulColor: vc.activeUlColor,
        offset: vc.rowOffset(row),
        getGrapheme: (idx) => vc.getGraphemeByIndex(idx),
      };
    };

    return {
      cols: this.cols,
      rows: this.rows,
      getCell: (row, col) => screen.getCell(row, col),
      viewportOffset: vpOff,
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
      getRowSource,
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

  /** Set the default cursor shape (before any escape-sequence overrides). */
  set cursorShape(shape: "block" | "underline" | "bar") {
    this.screen.cursorShape = shape;
  }
}
