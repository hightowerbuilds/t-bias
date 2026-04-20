import { type ParserHandler, SUB_PARAM_MARKER } from "./Parser";
import { VirtualCanvas } from "./VirtualCanvas";
import {
  type Cell, type Color, DEFAULT_COLOR,
  blankCell, paletteColor, rgbColor,
  isWideChar,
  BOLD, FAINT, ITALIC, BLINK, INVERSE, HIDDEN, STRIKETHROUGH, OVERLINE, WIDE,
  UL_MASK, UL_SHIFT, UL_SINGLE, UL_DOUBLE, UL_CURLY, UL_DOTTED, UL_DASHED,
} from "./types";

// ---------------------------------------------------------------------------
// Saved cursor state
// ---------------------------------------------------------------------------
interface SavedCursor {
  x: number;
  y: number;
  fg: Color;
  bg: Color;
  attrs: number;
  ulColor: Color;
  autoWrap: boolean;
}

// ---------------------------------------------------------------------------
// Screen — the terminal state machine
// ---------------------------------------------------------------------------
// All cell data is stored in VirtualCanvas (typed arrays). Screen owns only
// cursor state, modes, and the parsing handler interface.
export class Screen implements ParserHandler {
  cols: number;
  rows: number;

  // VirtualCanvas — THE sole cell data store
  private vc: VirtualCanvas;

  // Cursor
  cursorX = 0;
  cursorY = 0;
  cursorVisible = true;
  cursorShape: "block" | "underline" | "bar" = "block";
  private wrapPending = false;

  // Current pen
  private curFg: Color = DEFAULT_COLOR;
  private curBg: Color = DEFAULT_COLOR;
  private curAttrs = 0;
  private curUlColor: Color = DEFAULT_COLOR;

  // Saved cursor (DECSC / DECRC)
  private savedMain: SavedCursor | null = null;
  private savedAlt: SavedCursor | null = null;

  // Scroll region
  private scrollTop = 0;
  private scrollBottom: number;

  // Modes
  private isAltScreen = false;
  autoWrap = true;
  applicationCursor = false;
  bracketedPaste = false;
  private originMode = false;
  private insertMode = false;

  // Mouse modes
  mouseTrack = false;       // 1000: basic click tracking
  mouseDrag = false;        // 1002: button-event (drag) tracking
  mouseAll = false;          // 1003: any-event tracking
  mouseSgr = false;          // 1006: SGR extended encoding

  // Focus events
  focusEvents = false;       // 1004: send focus in/out events

  // Alternate scroll — when set, scroll events in alt screen send cursor keys
  alternateScroll = false;   // 1007

  // Scrollback viewport
  viewportOffset = 0;        // 0 = bottom (live), >0 = scrolled up

  // Tab stops
  private tabStops: Set<number>;

  // Character sets (G0-G3) and active set
  private charsets: (null | "dec-graphics")[] = [null, null, null, null];
  private glSet = 0;  // Active GL set (0=G0, 1=G1) — switched by SO/SI

  // Title
  title = "";
  private titleStack: string[] = [];

  // Callbacks
  onResponse?: (data: string) => void;
  onClipboard?: (data: string) => void;
  onResizeRequest?: (cols: number, rows: number) => void;

  // Last printed character (for REP)
  private lastChar = "";

  // OSC 8 hyperlink — active URL ID (0 = no URL)
  private currentUrlId = 0;

  constructor(cols: number, rows: number, vc: VirtualCanvas) {
    this.cols = cols;
    this.rows = rows;
    this.vc = vc;
    this.scrollBottom = rows - 1;

    this.tabStops = new Set<number>();
    for (let i = 8; i < cols; i += 8) this.tabStops.add(i);
  }

  // ========================================================================
  // Public accessors (for the Renderer / selection)
  // ========================================================================
  getCell(row: number, col: number): Cell {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return blankCell();

    // If scrolled up in scrollback, offset the row
    if (this.viewportOffset > 0 && !this.isAltScreen) {
      const scrollRow = this.vc.scrollbackLength - this.viewportOffset + row;
      if (scrollRow >= 0 && scrollRow < this.vc.scrollbackLength) {
        return this.vc.getScrollbackCell(scrollRow, col);
      }
      // Below the scrollback — render from active buffer
      const bufRow = row - (this.viewportOffset - Math.min(this.viewportOffset, this.vc.scrollbackLength));
      if (bufRow >= 0 && bufRow < this.rows) {
        return this.vc.getCell(bufRow, col);
      }
      return blankCell();
    }

    return this.vc.getCell(row, col);
  }

  get scrollbackLength(): number {
    return this.vc.scrollbackLength;
  }

  get isAlternateScreen(): boolean {
    return this.isAltScreen;
  }

  /** Whether any mouse tracking mode is active. */
  get mouseEnabled(): boolean {
    return this.mouseTrack;
  }

  scrollViewport(delta: number) {
    if (this.isAltScreen) return;
    this.viewportOffset = Math.max(0, Math.min(this.vc.scrollbackLength, this.viewportOffset + delta));
  }

  resetViewport() {
    this.viewportOffset = 0;
  }

  // ========================================================================
  // Resize
  // ========================================================================
  resize(newCols: number, newRows: number) {
    const oldCols = this.cols;
    const oldRows = this.rows;

    // Reflow active screen content when column count changes on the main screen.
    // Alt screen is never reflowed (matches xterm/kitty behavior).
    if (newCols !== oldCols && !this.isAltScreen) {
      this.reflowResize(oldCols, oldRows, newCols, newRows);
      return;
    }

    // VirtualCanvas handles its own resize (TerminalCore calls vc.resize separately).
    // Screen just needs to update dimensions and clamp cursor/scroll state.
    this.cols = newCols;
    this.rows = newRows;
    this.scrollBottom = newRows - 1;
    this.scrollTop = 0;

    // Clamp cursor
    this.cursorX = Math.min(this.cursorX, newCols - 1);
    this.cursorY = Math.min(this.cursorY, newRows - 1);

    // Trim scrollback (VC handles its own limit)
    this.vc.trimScrollback();
  }

  /**
   * Resize with content reflow. Extracts logical lines from the active screen,
   * resizes the underlying VirtualCanvas, then re-wraps lines to the new width.
   */
  private reflowResize(oldCols: number, oldRows: number, newCols: number, newRows: number) {
    // 1. Extract logical lines — groups of rows joined by soft-wrap flags.
    //    Each logical line is an array of cell data.
    type CellData = { char: string; fg: Color; bg: Color; attrs: number; ulColor: Color };
    type LogicalLine = CellData[];

    const lines: LogicalLine[] = [];
    let cursorLineIdx = -1;
    let cursorAbsCol = 0;

    let current: CellData[] = [];
    for (let r = 0; r < oldRows; r++) {
      for (let c = 0; c < oldCols; c++) {
        const cell = this.vc.getCell(r, c);
        // Skip wide-char placeholders (empty cell after a wide char)
        if (cell.char === "" && c > 0) {
          const prev = this.vc.getCell(r, c - 1);
          if (prev.attrs & WIDE) continue;
        }
        current.push({
          char: cell.char,
          fg: cell.fg,
          bg: cell.bg,
          attrs: cell.attrs,
          ulColor: cell.ulColor,
        });
      }

      // Track cursor position within logical lines
      if (r === this.cursorY) {
        cursorLineIdx = lines.length;
        cursorAbsCol = current.length - oldCols + this.cursorX;
      }

      // A logical line ends when the NEXT row is NOT a soft-wrapped continuation.
      // (The soft-wrap flag marks a row as continuing from the previous one.)
      const nextIsContinuation = r + 1 < oldRows && this.vc.isSoftWrapped(r + 1);
      if (!nextIsContinuation) {
        // End of logical line — trim trailing blanks
        while (current.length > 0 && current[current.length - 1].char === "") {
          current.pop();
        }
        lines.push(current);
        current = [];
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }

    // 2. Resize VirtualCanvas (this handles buffer allocation).
    this.vc.resize(newCols, newRows);
    this.cols = newCols;
    this.rows = newRows;
    this.scrollBottom = newRows - 1;
    this.scrollTop = 0;

    // Clear the active screen — reflow will write fresh content.
    for (let r = 0; r < newRows; r++) {
      this.vc.clearRow(r, DEFAULT_COLOR);
    }

    // 3. Re-wrap logical lines to new column width and write back.
    let writeRow = 0;
    let newCursorX = 0;
    let newCursorY = 0;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let col = 0;

      for (let ci = 0; ci < line.length; ci++) {
        const cell = line[ci];
        const wide = (cell.attrs & WIDE) !== 0;
        const cellWidth = wide ? 2 : 1;

        // Need to wrap?
        if (col + cellWidth > newCols) {
          if (writeRow < newRows) {
            this.vc.setSoftWrapped(writeRow, true);
          }
          writeRow++;
          col = 0;
        }

        if (writeRow >= newRows) {
          // Content overflows the screen — push to scrollback.
          // For now, excess content is lost (same as pre-reflow behavior).
          break;
        }

        this.vc.setCell(writeRow, col, cell.char, cell.fg, cell.bg, cell.attrs, cell.ulColor);
        if (wide && col + 1 < newCols) {
          this.vc.setCell(writeRow, col + 1, "", cell.fg, cell.bg, cell.attrs & ~WIDE, cell.ulColor);
        }
        col += cellWidth;

        // Track cursor in the new layout
        if (li === cursorLineIdx && ci === cursorAbsCol) {
          newCursorX = col;
          newCursorY = writeRow;
        }
      }

      // End of logical line — NOT soft-wrapped
      if (writeRow < newRows) {
        this.vc.setSoftWrapped(writeRow, false);
      }
      writeRow++;
    }

    // 4. Restore cursor
    this.cursorX = Math.min(newCursorX, newCols - 1);
    this.cursorY = Math.min(newCursorY, newRows - 1);
    this.wrapPending = false;

    this.vc.trimScrollback();
  }

  // ========================================================================
  // ParserHandler implementation
  // ========================================================================

  // ------- print -------
  print(char: string) {
    this.viewportOffset = 0;

    // Apply active character set mapping (DEC Special Graphics)
    const activeCharset = this.charsets[this.glSet];
    if (activeCharset === "dec-graphics") {
      char = mapDecGraphics(char);
    }

    const wide = isWideChar(char);

    // Deferred wrap
    if (this.wrapPending) {
      this.wrapPending = false;
      this.cursorX = 0;
      this.indexDown();
      // Mark the new row as a soft-wrapped continuation
      this.vc.setSoftWrapped(this.cursorY, true);
    }

    // Wide char won't fit at last col → wrap first
    if (wide && this.cursorX >= this.cols - 1) {
      if (this.autoWrap) {
        this.vc.setCell(this.cursorY, this.cursorX, "", DEFAULT_COLOR, this.curBg, 0, DEFAULT_COLOR);
        this.cursorX = 0;
        this.indexDown();
        this.vc.setSoftWrapped(this.cursorY, true);
      } else {
        return;
      }
    }

    if (this.insertMode) {
      this.vc.insertCells(this.cursorY, this.cursorX, wide ? 2 : 1, this.curBg);
    }

    if (this.cursorY < 0 || this.cursorY >= this.rows) {
      console.error(`[t-bias] print: cursorY=${this.cursorY} out of bounds (rows=${this.rows}, alt=${this.isAltScreen})`);
      return;
    }

    const printAttrs = this.curAttrs | (wide ? WIDE : 0);
    this.vc.setCell(this.cursorY, this.cursorX, char, this.curFg, this.curBg, printAttrs, this.curUlColor);
    if (this.currentUrlId !== 0) this.vc.setUrl(this.cursorY, this.cursorX, this.currentUrlId);

    if (wide && this.cursorX + 1 < this.cols) {
      this.vc.setCell(this.cursorY, this.cursorX + 1, "", this.curFg, this.curBg, this.curAttrs, this.curUlColor);
      if (this.currentUrlId !== 0) this.vc.setUrl(this.cursorY, this.cursorX + 1, this.currentUrlId);
    }

    const advance = wide ? 2 : 1;
    this.cursorX += advance;
    this.lastChar = char;

    if (this.cursorX >= this.cols) {
      this.cursorX = this.cols - 1;
      if (this.autoWrap) this.wrapPending = true;
    }
  }

  // ------- execute (C0 controls) -------
  execute(code: number) {
    switch (code) {
      case 0x07: break;                                     // BEL
      case 0x08: if (this.cursorX > 0) { this.cursorX--; this.wrapPending = false; } break; // BS
      case 0x09: this.horizontalTab(); break;               // HT
      case 0x0a: case 0x0b: case 0x0c: this.indexDown(); break; // LF, VT, FF
      case 0x0d: this.cursorX = 0; this.wrapPending = false; break; // CR
      case 0x0e: this.glSet = 1; break;                       // SO (shift out → G1)
      case 0x0f: this.glSet = 0; break;                     // SI (shift in → G0)
    }
  }

  // ------- escDispatch -------
  escDispatch(intermediates: string, final: string) {
    if (intermediates === "") {
      switch (final) {
        case "7": this.saveCursor(); break;                 // DECSC
        case "8": this.restoreCursor(); break;              // DECRC
        case "D": this.indexDown(); break;                   // IND
        case "E": this.cursorX = 0; this.indexDown(); break; // NEL
        case "H": this.tabStops.add(this.cursorX); break;  // HTS
        case "M": this.reverseIndex(); break;               // RI
        case "c": this.fullReset(); break;                  // RIS
        case "=": break;                                     // DECKPAM
        case ">": break;                                     // DECKPNM
      }
    } else if (intermediates === "#") {
      if (final === "8") this.decaln();                     // DECALN
    } else if (intermediates === "(") {
      this.designateCharset(0, final);                      // G0
    } else if (intermediates === ")") {
      this.designateCharset(1, final);                      // G1
    } else if (intermediates === "*") {
      this.designateCharset(2, final);                      // G2
    } else if (intermediates === "+") {
      this.designateCharset(3, final);                      // G3
    }
  }

  // ------- csiDispatch -------
  csiDispatch(params: number[], intermediates: string, final: string) {
    const p0 = params[0] || 0;
    const p1 = params[1] || 0;

    if (intermediates === "?") {
      // Private modes
      if (final === "h") { for (const p of params) this.setPrivateMode(p, true); return; }
      if (final === "l") { for (const p of params) this.setPrivateMode(p, false); return; }
      // DECRQM — request private mode: CSI ? Ps $ p
      // Handled below with "$" intermediate
    }

    // DECRQM — CSI ? Ps $ p (private) or CSI Ps $ p (standard)
    if (intermediates === "?$" && final === "p") {
      // Reply: CSI ? Ps ; Pm $ y — Pm: 1=set, 2=reset, 0=unknown
      const pm = this.queryPrivateMode(p0);
      this.onResponse?.(`\x1b[?${p0};${pm}$y`);
      return;
    }
    if (intermediates === "$" && final === "p") {
      // Standard mode query — reply with "unknown" for most
      const pm = p0 === 4 ? (this.insertMode ? 1 : 2) : 0;
      this.onResponse?.(`\x1b[${p0};${pm}$y`);
      return;
    }

    if (intermediates === ">") {
      if (final === "c") {
        // DA2 response
        this.onResponse?.("\x1b[>0;0;0c");
        return;
      }
      if (final === "q") {
        // XTVERSION — reply with DCS > | name ST
        this.onResponse?.("\x1bP>|t-bias 0.1.0\x1b\\");
        return;
      }
    }

    if (intermediates === "=") {
      if (final === "c") {
        // DA3 — tertiary device attributes: DCS ! | <hex id> ST
        this.onResponse?.("\x1bP!|00000000\x1b\\");
        return;
      }
    }

    // DECSTR — soft terminal reset: CSI ! p
    if (intermediates === "!" && final === "p") {
      this.softReset();
      return;
    }

    // DECSCUSR — cursor shape: CSI Ps SP q
    if (intermediates === " " && final === "q") {
      switch (p0) {
        case 0: case 1: this.cursorShape = "block"; break;
        case 2: this.cursorShape = "block"; break;
        case 3: this.cursorShape = "underline"; break;
        case 4: this.cursorShape = "underline"; break;
        case 5: this.cursorShape = "bar"; break;
        case 6: this.cursorShape = "bar"; break;
      }
      return;
    }

    if (intermediates !== "") return;                        // unknown intermediate

    switch (final) {
      case "A": this.moveCursor(0, -(p0 || 1)); break;     // CUU
      case "B": this.moveCursor(0, p0 || 1); break;        // CUD
      case "C": this.moveCursor(p0 || 1, 0); break;        // CUF
      case "D": this.moveCursor(-(p0 || 1), 0); break;     // CUB
      case "E": this.cursorX = 0; this.moveCursor(0, p0 || 1); break;  // CNL
      case "F": this.cursorX = 0; this.moveCursor(0, -(p0 || 1)); break; // CPL
      case "G": this.setCursorX(p0 ? p0 - 1 : 0); break;  // CHA
      case "H": case "f":                                   // CUP / HVP
        this.setCursorPos((p1 || 1) - 1, (p0 || 1) - 1);
        break;
      case "J": this.eraseDisplay(p0); break;               // ED
      case "K": this.eraseLine(p0); break;                  // EL
      case "L": this.insertLines(p0 || 1); break;           // IL
      case "M": this.deleteLines(p0 || 1); break;           // DL
      case "P": this.deleteChars(p0 || 1); break;           // DCH
      case "S": this.scrollUp(p0 || 1); break;              // SU
      case "T": this.scrollDown(p0 || 1); break;            // SD
      case "X": this.eraseChars(p0 || 1); break;            // ECH
      case "@": this.insertChars(p0 || 1); break;           // ICH
      case "b": this.repeatChar(p0 || 1); break;            // REP
      case "I": this.cursorForwardTab(p0 || 1); break;        // CHT
      case "Z": this.cursorBackwardTab(p0 || 1); break;     // CBT
      case "c":                                              // DA1
        this.onResponse?.("\x1b[?62;22c");
        break;
      case "d": this.setCursorY(p0 ? p0 - 1 : 0); break;  // VPA
      case "g":                                              // TBC
        if (p0 === 0) this.tabStops.delete(this.cursorX);
        else if (p0 === 3) this.tabStops.clear();
        break;
      case "h": if (p0 === 4) this.insertMode = true; break;  // SM (IRM)
      case "l": if (p0 === 4) this.insertMode = false; break; // RM (IRM)
      case "m": this.sgr(params); break;                    // SGR
      case "n":                                              // DSR
        if (p0 === 5) this.onResponse?.("\x1b[0n");
        if (p0 === 6) this.onResponse?.(`\x1b[${this.cursorY + 1};${this.cursorX + 1}R`);
        break;
      case "r": {                                             // DECSTBM
        const top = Math.max(0, (p0 || 1) - 1);
        const bot = Math.min(this.rows - 1, (p1 || this.rows) - 1);
        if (top < bot) {
          this.scrollTop = top;
          this.scrollBottom = bot;
        } else {
          // Invalid or reset — use full screen
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        this.setCursorPos(0, 0);
        break;
      }
      case "s": this.saveCursor(); break;                   // SCOSC
      case "t": this.windowOps(params); break;              // Window ops
      case "u": this.restoreCursor(); break;                // SCORC
      default: {
        const msg = `[t-bias] unhandled CSI params=[${params}] inter="${intermediates}" final="${final}"`;
        ((globalThis as any).__tbias_log ??= []).push(msg);
        if (typeof console !== "undefined" && (globalThis as any).__TAURI__?.core) {
          console.debug(msg);
        }
      }
    }
  }

  // Callbacks for host-level features
  onCwd?: (uri: string) => void;
  onShellIntegration?: (mark: string, param?: string) => void;

  // ------- oscDispatch -------
  oscDispatch(data: string) {
    console.log("[t-bias DEBUG] oscDispatch:", data);
    const semi = data.indexOf(";");
    if (semi < 0) {
      // Some OSC codes have no payload (e.g., OSC 104, OSC 112)
      const code = parseInt(data, 10);
      if (code === 104) return; // Reset all palette colors — no-op (we use theme defaults)
      if (code === 112) return; // Reset cursor color — no-op (we use theme default)
      return;
    }
    const code = parseInt(data.substring(0, semi), 10);
    const payload = data.substring(semi + 1);

    switch (code) {
      case 0: case 2:
        this.title = payload;
        break;
      case 1:
        // Icon name — treat as title
        this.title = payload;
        break;
      case 7:
        // CWD: OSC 7 ; file://hostname/path ST
        this.onCwd?.(payload);
        break;
      case 10:
        // Query/set foreground color
        if (payload === "?") {
          // No-op: reporting hardcoded colors can cause garbage in some shells
        }
        // Set foreground — not implemented (would need theme mutation)
        break;
      case 11:
        // Query/set background color
        if (payload === "?") {
          // No-op: reporting hardcoded colors can cause garbage in some shells
        }
        break;
      case 12:
        // Query/set cursor color
        if (payload === "?") {
          // No-op
        }
        break;
      case 52:
        // Clipboard: OSC 52 ; Pc ; Pd BEL
        this.onClipboard?.(payload);
        break;
      case 104:
        // Reset color N — no-op (we always use theme defaults)
        break;
      case 112:
        // Reset cursor color — no-op
        break;
      case 133:
        // Shell integration: OSC 133 ; <mark> [; <param>] ST
        // Marks: A=prompt start, B=command start, C=output start, D=command done
        this.onShellIntegration?.(payload.charAt(0), payload.length > 1 ? payload.substring(2) : undefined);
        break;
      case 8: {
        // OSC 8 ; params ; uri — hyperlink
        // payload = "params;uri" (we already stripped "8;")
        const semi2 = payload.indexOf(";");
        const uri = semi2 >= 0 ? payload.substring(semi2 + 1) : "";
        this.currentUrlId = uri ? this.vc.internUrl(uri) : 0;
        break;
      }
    }
  }

  // ------- dcsDispatch -------
  dcsDispatch(intermediates: string, params: number[], data: string) {
    // DECRQSS — DCS $ q <request> ST → reply with DCS 1 $ r <value> ST
    if (intermediates === "$" || data.startsWith("$q")) {
      const req = data.startsWith("$q") ? data.substring(2) : data;
      if (req === "r") {
        // DECSTBM — report scroll region
        this.onResponse?.(`\x1bP1$r${this.scrollTop + 1};${this.scrollBottom + 1}r\x1b\\`);
      } else if (req === "m") {
        // SGR — report current SGR state (simplified: just report reset)
        this.onResponse?.("\x1bP1$r0m\x1b\\");
      } else if (req === '"p') {
        // DECSCL — report conformance level
        this.onResponse?.('\x1bP1$r62"p\x1b\\');
      } else if (req === " q") {
        // DECSCUSR — report cursor style
        const style = this.cursorShape === "block" ? 1 : this.cursorShape === "underline" ? 3 : 5;
        this.onResponse?.(`\x1bP1$r${style} q\x1b\\`);
      } else {
        // Unknown request — reply with invalid
        this.onResponse?.("\x1bP0$r\x1b\\");
      }
      return;
    }

    // XTGETTCAP — DCS + q <hex-encoded-cap-name> ST
    // tmux probes for capabilities like RGB, Smulx, etc.
    if (data.startsWith("+q")) {
      const hexCap = data.substring(2);
      // Respond with "not found" for all — DCS 0 + r ST
      // This tells tmux to fall back to terminfo, which is correct behavior
      this.onResponse?.(`\x1bP0+r${hexCap}\x1b\\`);
      return;
    }
  }

  // ========================================================================
  // Cursor movement
  // ========================================================================
  private moveCursor(dx: number, dy: number) {
    this.wrapPending = false;
    this.cursorX = Math.max(0, Math.min(this.cols - 1, this.cursorX + dx));
    // CUU/CUD clamp to scroll region only if cursor is inside it;
    // otherwise clamp to screen bounds. Always clamp to rows-1 as final safety.
    const inRegion = this.cursorY >= this.scrollTop && this.cursorY <= this.scrollBottom;
    const top = inRegion ? this.scrollTop : 0;
    const bottom = inRegion ? Math.min(this.scrollBottom, this.rows - 1) : this.rows - 1;
    this.cursorY = Math.max(top, Math.min(bottom, this.cursorY + dy));
  }

  private setCursorX(x: number) {
    this.wrapPending = false;
    this.cursorX = Math.max(0, Math.min(this.cols - 1, x));
  }

  private setCursorY(y: number) {
    this.wrapPending = false;
    this.cursorY = Math.max(0, Math.min(this.rows - 1, y));
  }

  private setCursorPos(x: number, y: number) {
    this.wrapPending = false;
    this.cursorX = Math.max(0, Math.min(this.cols - 1, x));
    if (this.originMode) {
      this.cursorY = Math.max(this.scrollTop, Math.min(Math.min(this.scrollBottom, this.rows - 1), y + this.scrollTop));
    } else {
      this.cursorY = Math.max(0, Math.min(this.rows - 1, y));
    }
  }

  // ========================================================================
  // Scrolling
  // ========================================================================
  private indexDown() {
    if (this.cursorY === this.scrollBottom) {
      this.scrollRegionUp(1);
    } else if (this.cursorY < this.rows - 1) {
      this.cursorY++;
    }
  }

  private reverseIndex() {
    if (this.cursorY === this.scrollTop) {
      this.scrollRegionDown(1);
    } else if (this.cursorY > 0) {
      this.cursorY--;
    }
  }

  private scrollRegionUp(n: number) {
    for (let i = 0; i < n; i++) {
      this.vc.scrollUp(this.scrollTop, this.scrollBottom, this.curBg);
    }
  }

  private scrollRegionDown(n: number) {
    for (let i = 0; i < n; i++) {
      this.vc.scrollDown(this.scrollTop, this.scrollBottom, this.curBg);
    }
  }

  scrollUp(n: number) { this.scrollRegionUp(n); }
  scrollDown(n: number) { this.scrollRegionDown(n); }

  // ========================================================================
  // Erase
  // ========================================================================
  private eraseDisplay(mode: number) {
    switch (mode) {
      case 0: // below
        this.vc.eraseRange(this.cursorY, this.cursorX, this.cols, this.curBg);
        for (let r = this.cursorY + 1; r < this.rows; r++)
          this.vc.clearRow(r, this.curBg);
        break;
      case 1: // above
        for (let r = 0; r < this.cursorY; r++)
          this.vc.clearRow(r, this.curBg);
        this.vc.eraseRange(this.cursorY, 0, this.cursorX + 1, this.curBg);
        break;
      case 2: // entire screen
        for (let r = 0; r < this.rows; r++)
          this.vc.clearRow(r, this.curBg);
        break;
      case 3: // entire screen + scrollback
        this.vc.clearScrollback();
        for (let r = 0; r < this.rows; r++)
          this.vc.clearRow(r, this.curBg);
        break;
    }
  }

  private eraseLine(mode: number) {
    switch (mode) {
      case 0: this.vc.eraseRange(this.cursorY, this.cursorX, this.cols, this.curBg); break;
      case 1: this.vc.eraseRange(this.cursorY, 0, this.cursorX + 1, this.curBg); break;
      case 2: this.vc.clearRow(this.cursorY, this.curBg); break;
    }
  }

  private eraseChars(n: number) {
    const end = Math.min(this.cursorX + n, this.cols);
    this.vc.eraseRange(this.cursorY, this.cursorX, end, this.curBg);
  }

  // ========================================================================
  // Insert / delete
  // ========================================================================
  private insertLines(n: number) {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;
    for (let i = 0; i < n; i++) {
      this.vc.scrollDown(this.cursorY, this.scrollBottom, this.curBg);
    }
  }

  private deleteLines(n: number) {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;
    for (let i = 0; i < n; i++) {
      this.vc.scrollUp(this.cursorY, this.scrollBottom, this.curBg);
    }
  }

  private insertChars(n: number) {
    this.vc.insertCells(this.cursorY, this.cursorX, n, this.curBg);
  }

  private deleteChars(n: number) {
    this.vc.deleteCells(this.cursorY, this.cursorX, n, this.curBg);
  }

  private repeatChar(n: number) {
    if (!this.lastChar) return;
    for (let i = 0; i < n; i++) this.print(this.lastChar);
  }

  // ========================================================================
  // Tab
  // ========================================================================
  private horizontalTab() {
    this.cursorForwardTab(1);
  }

  private cursorForwardTab(n: number) {
    this.wrapPending = false;
    const sorted = [...this.tabStops].filter((t) => t > this.cursorX).sort((a, b) => a - b);
    if (n <= sorted.length) {
      this.cursorX = Math.min(sorted[n - 1], this.cols - 1);
    } else {
      this.cursorX = this.cols - 1;
    }
  }

  private cursorBackwardTab(n: number) {
    this.wrapPending = false;
    const sorted = [...this.tabStops].filter((t) => t < this.cursorX).sort((a, b) => b - a);
    if (n <= sorted.length) {
      this.cursorX = Math.max(sorted[n - 1], 0);
    } else {
      this.cursorX = 0;
    }
  }

  // ========================================================================
  // SGR (Select Graphic Rendition)
  // ========================================================================
  private sgr(params: number[]) {
    if (params.length === 0) params = [0];

    for (let i = 0; i < params.length; i++) {
      const p = params[i];

      switch (p) {
        case 0: // Reset
          this.curFg = DEFAULT_COLOR;
          this.curBg = DEFAULT_COLOR;
          this.curAttrs = 0;
          this.curUlColor = DEFAULT_COLOR;
          break;
        case 1: this.curAttrs |= BOLD; break;
        case 2: this.curAttrs |= FAINT; break;
        case 3: this.curAttrs |= ITALIC; break;
        case 4: {
          // Check for colon sub-parameter: 4:N sets underline style
          // The parser inserts SUB_PARAM_MARKER (-1) for colons, so
          // 4:3 arrives as [4, -1, 3] in the params array.
          if (i + 2 < params.length && params[i + 1] === SUB_PARAM_MARKER) {
            const style = params[i + 2];
            const ul = style <= 5 ? (style << UL_SHIFT) : UL_SINGLE;
            this.curAttrs = (this.curAttrs & ~UL_MASK) | ul;
            i += 2; // skip the marker and style value
          } else {
            this.curAttrs = (this.curAttrs & ~UL_MASK) | UL_SINGLE;
          }
          break;
        }
        case 5: this.curAttrs |= BLINK; break;
        case 7: this.curAttrs |= INVERSE; break;
        case 8: this.curAttrs |= HIDDEN; break;
        case 9: this.curAttrs |= STRIKETHROUGH; break;
        case 21: this.curAttrs = (this.curAttrs & ~UL_MASK) | UL_DOUBLE; break;
        case 22: this.curAttrs &= ~(BOLD | FAINT); break;
        case 23: this.curAttrs &= ~ITALIC; break;
        case 24: this.curAttrs &= ~UL_MASK; break;
        case 25: this.curAttrs &= ~BLINK; break;
        case 27: this.curAttrs &= ~INVERSE; break;
        case 28: this.curAttrs &= ~HIDDEN; break;
        case 29: this.curAttrs &= ~STRIKETHROUGH; break;

        // Foreground colors
        case 30: case 31: case 32: case 33:
        case 34: case 35: case 36: case 37:
          this.curFg = paletteColor(p - 30);
          break;
        case 38:
          i = this.parseExtendedColor(params, i, true);
          break;
        case 39: this.curFg = DEFAULT_COLOR; break;

        // Background colors
        case 40: case 41: case 42: case 43:
        case 44: case 45: case 46: case 47:
          this.curBg = paletteColor(p - 40);
          break;
        case 48:
          i = this.parseExtendedColor(params, i, false);
          break;
        case 49: this.curBg = DEFAULT_COLOR; break;

        case 53: this.curAttrs |= OVERLINE; break;
        case 55: this.curAttrs &= ~OVERLINE; break;

        // Underline color
        case 58:
          i = this.parseExtendedColor(params, i, true, true);
          break;
        case 59: this.curUlColor = DEFAULT_COLOR; break;

        // Bright foreground
        case 90: case 91: case 92: case 93:
        case 94: case 95: case 96: case 97:
          this.curFg = paletteColor(p - 90 + 8);
          break;

        // Bright background
        case 100: case 101: case 102: case 103:
        case 104: case 105: case 106: case 107:
          this.curBg = paletteColor(p - 100 + 8);
          break;
      }
    }
  }

  private parseExtendedColor(params: number[], i: number, isFg: boolean, isUl = false): number {
    // Collect the values after the 38/48/58, skipping SUB_PARAM_MARKER entries.
    // This handles both semicolon form (38;2;R;G;B) and colon form (38:2:R:G:B).
    const vals: number[] = [];
    let j = i + 1;
    while (j < params.length && vals.length < 5) {
      const v = params[j];
      if (v === SUB_PARAM_MARKER) { j++; continue; }
      // Stop if we hit a value that looks like the start of a new SGR attribute
      // (only applies to semicolon form — in colon form everything is sub-params)
      vals.push(v);
      j++;
      // In semicolon form, we stop collecting after the expected count
      if (vals.length >= 2 && vals[0] === 5) break;       // 38;5;N → 2 values
      if (vals.length >= 4 && vals[0] === 2) break;        // 38;2;R;G;B → 4 values
    }

    if (vals[0] === 5 && vals.length >= 2) {
      const color = paletteColor(vals[1]);
      if (isUl) this.curUlColor = color;
      else if (isFg) this.curFg = color;
      else this.curBg = color;
      return j - 1;
    }

    if (vals[0] === 2 && vals.length >= 4) {
      const color = rgbColor(vals[1], vals[2], vals[3]);
      if (isUl) this.curUlColor = color;
      else if (isFg) this.curFg = color;
      else this.curBg = color;
      return j - 1;
    }

    return i;
  }

  // ========================================================================
  // Private modes (DECSET / DECRST)
  // ========================================================================

  /** Query private mode state for DECRQM. Returns 1=set, 2=reset, 0=unknown. */
  private queryPrivateMode(mode: number): number {
    switch (mode) {
      case 1: return this.applicationCursor ? 1 : 2;
      case 6: return this.originMode ? 1 : 2;
      case 7: return this.autoWrap ? 1 : 2;
      case 12: return 2; // cursor blink — always report as reset
      case 25: return this.cursorVisible ? 1 : 2;
      case 47: case 1047: return this.isAltScreen ? 1 : 2;
      case 1000: return this.mouseTrack ? 1 : 2;
      case 1002: return this.mouseDrag ? 1 : 2;
      case 1003: return this.mouseAll ? 1 : 2;
      case 1004: return this.focusEvents ? 1 : 2;
      case 1006: return this.mouseSgr ? 1 : 2;
      case 1049: return this.isAltScreen ? 1 : 2;
      case 1007: return this.alternateScroll ? 1 : 2;
      case 1048: return 2; // cursor save/restore — stateless query, report as reset
      case 2004: return this.bracketedPaste ? 1 : 2;
      case 2026: return 2; // synchronized output — accepted but always "reset"
      default: return 0; // unknown
    }
  }

  private setPrivateMode(mode: number, enable: boolean) {
    switch (mode) {
      case 1:                                               // DECCKM
        this.applicationCursor = enable;
        break;
      case 6:                                               // DECOM
        this.originMode = enable;
        if (enable) this.setCursorPos(0, 0);
        break;
      case 7:                                               // DECAWM
        this.autoWrap = enable;
        break;
      case 12:                                              // Cursor blink
        break;
      case 25:                                              // DECTCEM
        this.cursorVisible = enable;
        break;
      case 47:                                              // Alt screen (no save)
        if (enable) this.switchToAlt();
        else this.switchToMain();
        break;
      case 1004:                                            // Focus events
        this.focusEvents = enable;
        break;
      case 1000:                                            // Mouse click tracking
        this.mouseTrack = enable;
        if (!enable) { this.mouseDrag = false; this.mouseAll = false; }
        break;
      case 1002:                                            // Mouse drag tracking
        this.mouseDrag = enable;
        if (enable) this.mouseTrack = true;
        break;
      case 1003:                                            // Mouse any-event tracking
        this.mouseAll = enable;
        if (enable) { this.mouseTrack = true; this.mouseDrag = true; }
        break;
      case 1006:                                            // SGR extended mouse encoding
        this.mouseSgr = enable;
        break;
      case 1047:                                            // Alt screen (no save)
        if (enable) this.switchToAlt();
        else this.switchToMain();
        break;
      case 1005:                                            // UTF-8 mouse encoding (accepted, use SGR instead)
        break;
      case 1007:                                            // Alternate scroll mode
        this.alternateScroll = enable;
        break;
      case 1015:                                            // URXVT mouse encoding (accepted, use SGR instead)
        break;
      case 1036:                                            // Meta sends ESC (accepted, default behavior)
        break;
      case 1048:                                            // Save/restore cursor (standalone)
        if (enable) this.saveCursor();
        else this.restoreCursor();
        break;
      case 2026:                                            // Synchronized output (no-op, accepted)
        break;
      case 1049:                                            // Alt screen + save/restore
        if (enable) {
          this.saveCursor();
          this.switchToAlt();
          this.eraseDisplay(2);
        } else {
          this.switchToMain();
          this.restoreCursor();
        }
        break;
      case 2004:                                            // Bracketed paste
        this.bracketedPaste = enable;
        break;
      default: {
        const msg = `[t-bias] unhandled DECSET mode=${mode} enable=${enable}`;
        ((globalThis as any).__tbias_log ??= []).push(msg);
        if (typeof console !== "undefined" && (globalThis as any).__TAURI__?.core) {
          console.debug(msg);
        }
      }
    }
  }

  // ========================================================================
  // Alt screen
  // ========================================================================
  private switchToAlt() {
    if (this.isAltScreen) return;
    this.isAltScreen = true;
    this.vc.switchToAlt();
  }

  private switchToMain() {
    if (!this.isAltScreen) return;
    this.isAltScreen = false;
    this.vc.switchToMain();
  }

  // ========================================================================
  // Save / restore cursor
  // ========================================================================
  private saveCursor() {
    const s: SavedCursor = {
      x: this.cursorX, y: this.cursorY,
      fg: this.curFg, bg: this.curBg,
      attrs: this.curAttrs, ulColor: this.curUlColor,
      autoWrap: this.autoWrap,
    };
    if (this.isAltScreen) this.savedAlt = s;
    else this.savedMain = s;
  }

  private restoreCursor() {
    const s = this.isAltScreen ? this.savedAlt : this.savedMain;
    if (!s) return;
    this.cursorX = s.x;
    this.cursorY = s.y;
    this.curFg = s.fg;
    this.curBg = s.bg;
    this.curAttrs = s.attrs;
    this.curUlColor = s.ulColor;
    this.autoWrap = s.autoWrap;
    this.wrapPending = false;
  }

  // ========================================================================
  // Window operations
  // ========================================================================
  private windowOps(params: number[]) {
    switch (params[0]) {
      case 8: {
        // Set text area size in characters — vim sends this.
        // We report our actual size; the resize is handled by the host.
        const reqRows = params[1] || this.rows;
        const reqCols = params[2] || this.cols;
        this.onResizeRequest?.(reqCols, reqRows);
        break;
      }
      case 11: // Report window state — always report as non-iconified
        this.onResponse?.("\x1b[1t");
        break;
      case 14: // Report window size in pixels — approximate from grid
        this.onResponse?.(`\x1b[4;${this.rows * 16};${this.cols * 8}t`);
        break;
      case 16: // Report cell size in pixels
        this.onResponse?.("\x1b[6;16;8t");
        break;
      case 18: // Report terminal size in characters
        this.onResponse?.(`\x1b[8;${this.rows};${this.cols}t`);
        break;
      case 22: // Push title
        this.titleStack.push(this.title);
        break;
      case 23: // Pop title
        if (this.titleStack.length > 0) {
          this.title = this.titleStack.pop()!;
        }
        break;
    }
  }

  // ========================================================================
  // Character set designation
  // ========================================================================
  private designateCharset(g: number, final: string) {
    switch (final) {
      case "0": this.charsets[g] = "dec-graphics"; break;  // DEC Special Graphics
      case "B": this.charsets[g] = null; break;             // ASCII
      case "A": this.charsets[g] = null; break;             // UK (treat as ASCII)
      default:  this.charsets[g] = null; break;             // Unknown → ASCII
    }
  }

  // ========================================================================
  // Soft reset (DECSTR)
  // ========================================================================
  private softReset() {
    this.curFg = DEFAULT_COLOR;
    this.curBg = DEFAULT_COLOR;
    this.curAttrs = 0;
    this.curUlColor = DEFAULT_COLOR;
    this.cursorVisible = true;
    this.cursorShape = "block";
    this.wrapPending = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.autoWrap = true;
    this.applicationCursor = false;
    this.bracketedPaste = false;
    this.originMode = false;
    this.insertMode = false;
    this.charsets = [null, null, null, null];
    this.glSet = 0;
    this.savedMain = null;
    this.savedAlt = null;
  }

  // ========================================================================
  // DECALN (fill screen with 'E')
  // ========================================================================
  private decaln() {
    this.vc.fillCells("E", DEFAULT_COLOR, DEFAULT_COLOR, 0, DEFAULT_COLOR,
      0, 0, this.rows, this.cols);
  }

  // ========================================================================
  // Full reset (RIS)
  // ========================================================================
  private fullReset() {
    this.currentUrlId = 0;
    this.curFg = DEFAULT_COLOR;
    this.curBg = DEFAULT_COLOR;
    this.curAttrs = 0;
    this.curUlColor = DEFAULT_COLOR;
    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorVisible = true;
    this.cursorShape = "block";
    this.wrapPending = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.autoWrap = true;
    this.applicationCursor = false;
    this.bracketedPaste = false;
    this.originMode = false;
    this.insertMode = false;
    this.isAltScreen = false;
    this.savedMain = null;
    this.savedAlt = null;
    this.charsets = [null, null, null, null];
    this.glSet = 0;
    this.title = "";
    this.titleStack = [];
    this.lastChar = "";
    this.focusEvents = false;
    this.tabStops.clear();
    for (let i = 8; i < this.cols; i += 8) this.tabStops.add(i);
    // Reset all cell data in both pages + scrollback
    this.vc.resetAll();
  }
}

// ---------------------------------------------------------------------------
// DEC Special Graphics character set mapping
// ---------------------------------------------------------------------------
// Maps ASCII 0x60–0x7E to Unicode box-drawing / symbol equivalents
// when the DEC Special Graphics set is active (ESC ( 0).

const DEC_GRAPHICS_MAP: Record<string, string> = {
  "`": "\u25C6", // ◆ diamond
  "a": "\u2592", // ▒ checkerboard
  "b": "\u2409", // HT symbol
  "c": "\u240C", // FF symbol
  "d": "\u240D", // CR symbol
  "e": "\u240A", // LF symbol
  "f": "\u00B0", // ° degree
  "g": "\u00B1", // ± plus/minus
  "h": "\u2424", // NL symbol
  "i": "\u240B", // VT symbol
  "j": "\u2518", // ┘ lower right
  "k": "\u2510", // ┐ upper right
  "l": "\u250C", // ┌ upper left
  "m": "\u2514", // └ lower left
  "n": "\u253C", // ┼ crossing
  "o": "\u23BA", // ⎺ scan 1
  "p": "\u23BB", // ⎻ scan 3
  "q": "\u2500", // ─ horizontal
  "r": "\u23BC", // ⎼ scan 7
  "s": "\u23BD", // ⎽ scan 9
  "t": "\u251C", // ├ left tee
  "u": "\u2524", // ┤ right tee
  "v": "\u2534", // ┴ bottom tee
  "w": "\u252C", // ┬ top tee
  "x": "\u2502", // │ vertical
  "y": "\u2264", // ≤ less-equal
  "z": "\u2265", // ≥ greater-equal
  "{": "\u03C0", // π pi
  "|": "\u2260", // ≠ not-equal
  "}": "\u00A3", // £ pound
  "~": "\u00B7", // · middle dot
};

function mapDecGraphics(char: string): string {
  return DEC_GRAPHICS_MAP[char] ?? char;
}
