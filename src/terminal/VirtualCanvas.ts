import { type Cell, type Color, DEFAULT_COLOR } from "./types";

// ---------------------------------------------------------------------------
// VirtualCanvas — typed-array cell buffer
// ---------------------------------------------------------------------------
// Stores terminal cell data in Structure-of-Arrays layout (cache-friendly,
// SharedArrayBuffer-ready for future Rust migration). Change tracking uses
// a dirty bitmap with sub-row column ranges for efficient partial redraws.
//
// Scrollback uses a pre-allocated ring buffer (single ArrayBuffer) instead
// of per-row typed array slices — zero allocation on push, O(1) eviction.
//
// Row indirection (rowMap) enables zero-copy scroll: logical rows map to
// physical rows via a Uint16Array, so scroll just rotates indices.
//
// Graphemes are stored per-row (keyed by column, not flat index) so they
// travel with their row during scroll and don't break on resize.
// The rowGraphemes array is indexed by PHYSICAL row, not logical row.

/** Sentinel in chars[] meaning "look up the row's grapheme map for the actual string". */
const GRAPHEME_SENTINEL = 0xFFFFFFFF;

// OSC 133 shell-integration prompt mark values (stored in Uint8Arrays)
export const MARK_NONE    = 0;
export const MARK_A       = 1;  // prompt start
export const MARK_B       = 2;  // command start (end of prompt)
export const MARK_C       = 3;  // output start (command accepted)
export const MARK_D_UNKNOWN = 4; // command done, no exit code
export const MARK_D_SUCCESS = 5; // command done, exit 0
export const MARK_D_FAILURE = 6; // command done, exit non-zero

/** Number of typed-array attributes per cell (chars, fg, bg, attrs, ulColor). */
const ATTRS_PER_CELL = 5;

/** Minimum physical columns for oversized buffer allocation (I10). */
const MIN_PHYS_COLS = 320;

/** Minimum physical rows for oversized buffer allocation (I10). */
const MIN_PHYS_ROWS = 100;

/** A single buffer page (main or alt screen). */
interface BufferPage {
  chars: Uint32Array;
  fg: Uint32Array;
  bg: Uint32Array;
  attrs: Uint32Array;
  ulColor: Uint32Array;
  url: Uint16Array;   // URL ID per cell (0 = none, 1-indexed into urlTable)
}

export class VirtualCanvas {
  // Grid dimensions (logical — what the terminal sees)
  cols: number;
  rows: number;

  // Physical allocation dimensions (>= logical, for oversized buffer I10)
  private physCols: number;
  private physRows: number;

  // Dual buffer pages (main + alt screen)
  private mainPage: BufferPage;
  private altPage: BufferPage;
  private activePage: BufferPage;
  private isAlt = false;

  // Row indirection tables (I6) — logical → physical row mapping
  private mainRowMap: Uint16Array;
  private altRowMap: Uint16Array;
  private activeRowMap: Uint16Array;

  // Per-row grapheme storage (keyed by column, null when no graphemes)
  // Indexed by PHYSICAL row, not logical row.
  private rowGraphemes: (Map<number, string> | null)[];

  // Soft-wrap tracking: 1 = this row is a continuation of the previous row
  // Indexed by physical row. Used for reflow on resize.
  private softWrapped: Uint8Array;

  // Dirty tracking (I9: sub-row dirty ranges alongside bitmap)
  dirtyBitmap: Uint8Array;
  dirtyColStart: Uint16Array;
  dirtyColEnd: Uint16Array;

  // Scrollback ring buffer
  // 4.2: attrs stored as Uint16Array (12 bits used), ulColor dropped (always DEFAULT_COLOR)
  private sbChars: Uint32Array;
  private sbFg: Uint32Array;
  private sbBg: Uint32Array;
  private sbAttrs: Uint16Array;
  private sbHead = 0;    // index of oldest row
  private sbCount = 0;   // number of rows stored
  private sbCols: number; // column width the ring was allocated for
  private scrollbackLimit: number;

  // URL intern table for OSC 8 hyperlinks (1-indexed; 0 = no URL)
  private urlTable: string[] = [];
  private urlByStr = new Map<string, number>();

  // OSC 133 prompt marks — one byte per physical row / scrollback slot
  private sbPromptMark: Uint8Array;     // indexed by scrollback slot
  // Soft-wrap tracking for scrollback rows (1 = continuation of previous row)
  private sbSoftWrapped: Uint8Array;
  private activePromptMark: Uint8Array; // indexed by physical row

  constructor(cols: number, rows: number, scrollbackLimit = 5000) {
    this.cols = cols;
    this.rows = rows;
    this.scrollbackLimit = scrollbackLimit;

    // I10: Oversized buffer allocation — pre-allocate at minimum physical size
    this.physCols = Math.max(cols, MIN_PHYS_COLS);
    this.physRows = Math.max(rows, MIN_PHYS_ROWS);

    this.mainPage = this.makePage(this.physCols, this.physRows);
    this.altPage = this.makePage(this.physCols, this.physRows);
    this.activePage = this.mainPage;

    // I6: Row indirection — identity mapping initially
    this.mainRowMap = new Uint16Array(this.physRows);
    this.altRowMap = new Uint16Array(this.physRows);
    for (let i = 0; i < this.physRows; i++) {
      this.mainRowMap[i] = i;
      this.altRowMap[i] = i;
    }
    this.activeRowMap = this.mainRowMap;

    // I9: Sub-row dirty tracking
    this.dirtyBitmap = new Uint8Array(this.physRows);
    this.dirtyColStart = new Uint16Array(this.physRows);
    this.dirtyColEnd = new Uint16Array(this.physRows);
    this.markAllDirty();

    // Per-row graphemes indexed by physical row
    this.rowGraphemes = new Array(this.physRows).fill(null);
    this.softWrapped = new Uint8Array(this.physRows);

    // Prompt marks (one byte per slot / physical row)
    this.sbPromptMark = new Uint8Array(scrollbackLimit);
    this.sbSoftWrapped = new Uint8Array(scrollbackLimit);
    this.activePromptMark = new Uint8Array(this.physRows);

    // Allocate scrollback ring buffer (4.2: Uint16Array for attrs, no ulColor)
    this.sbCols = cols;
    const sbSize = scrollbackLimit * cols;
    this.sbChars = new Uint32Array(sbSize);
    this.sbFg = new Uint32Array(sbSize);
    this.sbBg = new Uint32Array(sbSize);
    this.sbAttrs = new Uint16Array(sbSize);
  }

  // =========================================================================
  // Page management
  // =========================================================================
  private makePage(physCols: number, physRows: number): BufferPage {
    const size = physCols * physRows;
    return {
      chars: new Uint32Array(size),      // 0 = empty
      fg: new Uint32Array(size),         // DEFAULT_COLOR = 0
      bg: new Uint32Array(size),         // DEFAULT_COLOR = 0
      attrs: new Uint32Array(size),      // 0 = no attributes
      ulColor: new Uint32Array(size),    // DEFAULT_COLOR = 0
      url: new Uint16Array(size),        // 0 = no URL
    };
  }

  // =========================================================================
  // Row indirection (I6)
  // =========================================================================

  /** PUBLIC: Get the byte offset into typed arrays for a logical row.
   *  Used by the renderer and debug dump to index into activeChars etc. */
  rowOffset(logicalRow: number): number {
    return this.activeRowMap[logicalRow] * this.physCols;
  }

  /** Initialize a rowMap to identity mapping. */
  private resetRowMap(rowMap: Uint16Array): void {
    for (let i = 0; i < rowMap.length; i++) {
      rowMap[i] = i;
    }
  }

  /** Repack a page's cell data so physical row order matches identity mapping.
   *  Must be called BEFORE resetRowMap() when no reallocation occurs on resize,
   *  otherwise the row map reset scrambles the display. */
  private repackPageToIdentity(
    page: BufferPage,
    rowMap: Uint16Array,
    logicalRows: number,
    logicalCols: number,
  ): void {
    const stride = this.physCols;

    // Check if already identity — skip the copy if so
    let isIdentity = true;
    for (let r = 0; r < logicalRows; r++) {
      if (rowMap[r] !== r) { isIdentity = false; break; }
    }
    if (isIdentity) return;

    // Use a temporary buffer to hold one row during the permutation cycle walk
    const tempRow = new Uint32Array(stride);
    const visited = new Uint8Array(logicalRows);

    for (let start = 0; start < logicalRows; start++) {
      if (visited[start] || rowMap[start] === start) {
        visited[start] = 1;
        continue;
      }

      // Walk the permutation cycle: start → rowMap[start] → ...
      // Save physical row at 'start' into temp
      const startOff = start * stride;
      tempRow.set(page.chars.subarray(startOff, startOff + logicalCols));
      const tempFg = new Uint32Array(page.fg.subarray(startOff, startOff + logicalCols));
      const tempBg = new Uint32Array(page.bg.subarray(startOff, startOff + logicalCols));
      const tempAttrs = new Uint32Array(page.attrs.subarray(startOff, startOff + logicalCols));
      const tempUl = new Uint32Array(page.ulColor.subarray(startOff, startOff + logicalCols));
      const tempUrl = new Uint16Array(page.url.subarray(startOff, startOff + logicalCols));
      const tempGraphemes = this.rowGraphemes[start];
      const tempSoftWrap = this.softWrapped[start];

      let dst = start;
      let src = rowMap[start];
      while (src !== start) {
        // Copy physical row 'src' into physical row 'dst'
        const srcOff = src * stride;
        const dstOff = dst * stride;
        page.chars.copyWithin(dstOff, srcOff, srcOff + logicalCols);
        page.fg.copyWithin(dstOff, srcOff, srcOff + logicalCols);
        page.bg.copyWithin(dstOff, srcOff, srcOff + logicalCols);
        page.attrs.copyWithin(dstOff, srcOff, srcOff + logicalCols);
        page.ulColor.copyWithin(dstOff, srcOff, srcOff + logicalCols);
        page.url.copyWithin(dstOff, srcOff, srcOff + logicalCols);
        this.rowGraphemes[dst] = this.rowGraphemes[src];
        this.softWrapped[dst] = this.softWrapped[src];
        visited[dst] = 1;
        dst = src;
        src = rowMap[src];
      }

      // Final step: place saved temp into the last slot of the cycle
      const dstOff = dst * stride;
      page.chars.set(tempRow.subarray(0, logicalCols), dstOff);
      page.fg.set(tempFg, dstOff);
      page.bg.set(tempBg, dstOff);
      page.attrs.set(tempAttrs, dstOff);
      page.ulColor.set(tempUl, dstOff);
      page.url.set(tempUrl, dstOff);
      this.rowGraphemes[dst] = tempGraphemes;
      this.softWrapped[dst] = tempSoftWrap;
      visited[dst] = 1;
    }
  }

  // =========================================================================
  // Cell access
  // =========================================================================

  /** Write a cell. Used by Screen during parsing. */
  setCell(row: number, col: number, char: string, fg: Color, bg: Color, attrs: number, ulColor: Color): void {
    const idx = this.activeRowMap[row] * this.physCols + col;
    const page = this.activePage;

    // Compute the codepoint to store
    let newCp: number;
    if (char.length === 0) {
      newCp = 0;
    } else {
      const cp = char.codePointAt(0)!;
      const cpLen = cp > 0xFFFF ? 2 : 1;
      newCp = char.length === cpLen ? cp : GRAPHEME_SENTINEL;
    }

    // I2: No-op detection — skip if nothing changed (5 integer comparisons)
    const physRow = this.activeRowMap[row];
    if (page.chars[idx] === newCp && page.fg[idx] === fg && page.bg[idx] === bg
        && page.attrs[idx] === attrs && page.ulColor[idx] === ulColor
        && (newCp !== GRAPHEME_SENTINEL || this.getGraphemePhys(physRow, col) === char)) {
      return;
    }

    // I3: Only touch grapheme map when necessary
    const oldCp = page.chars[idx];
    page.chars[idx] = newCp;
    if (newCp === GRAPHEME_SENTINEL) {
      this.setGraphemePhys(physRow, col, char);
    } else if (oldCp === GRAPHEME_SENTINEL) {
      this.deleteGraphemePhys(physRow, col);
    }

    page.fg[idx] = fg;
    page.bg[idx] = bg;
    page.attrs[idx] = attrs;
    page.ulColor[idx] = ulColor;

    // I9: Sub-row dirty tracking
    this.markDirtyCell(row, col);
  }

  /** Read a cell (compatibility shim for getCell interface). */
  getCell(row: number, col: number): Cell {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return { char: "", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0, ulColor: DEFAULT_COLOR };
    }

    const page = this.activePage;
    const idx = this.activeRowMap[row] * this.physCols + col;
    const physRow = this.activeRowMap[row];
    const cp = page.chars[idx];
    const char = cp === GRAPHEME_SENTINEL
      ? (this.getGraphemePhys(physRow, col) ?? "")
      : cp === 0 ? "" : String.fromCodePoint(cp);

    return {
      char,
      fg: page.fg[idx],
      bg: page.bg[idx],
      attrs: page.attrs[idx],
      ulColor: page.ulColor[idx],
    };
  }

  /** Read a cell from scrollback. Row 0 = oldest. */
  getScrollbackCell(scrollRow: number, col: number): Cell {
    if (scrollRow < 0 || scrollRow >= this.sbCount || col < 0 || col >= this.cols) {
      return { char: "", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0, ulColor: DEFAULT_COLOR };
    }
    const physRow = (this.sbHead + scrollRow) % this.scrollbackLimit;
    const off = physRow * this.sbCols + col;
    const cp = this.sbChars[off];
    const char = cp === 0 ? "" : String.fromCodePoint(cp);
    return { char, fg: this.sbFg[off], bg: this.sbBg[off], attrs: this.sbAttrs[off], ulColor: DEFAULT_COLOR };
  }

  /** Read char string at a position (direct access, no Cell allocation). */
  getChar(row: number, col: number): string {
    const idx = this.activeRowMap[row] * this.physCols + col;
    const cp = this.activePage.chars[idx];
    if (cp === 0) return "";
    if (cp === GRAPHEME_SENTINEL) return this.getGraphemePhys(this.activeRowMap[row], col) ?? "";
    return String.fromCodePoint(cp);
  }

  // =========================================================================
  // Soft-wrap tracking
  // =========================================================================

  /** Mark a logical row as a soft-wrapped continuation of the previous row. */
  setSoftWrapped(row: number, wrapped: boolean): void {
    const physRow = this.activeRowMap[row];
    this.softWrapped[physRow] = wrapped ? 1 : 0;
  }

  /** Check if a logical row is soft-wrapped. */
  isSoftWrapped(row: number): boolean {
    return this.softWrapped[this.activeRowMap[row]] === 1;
  }

  // =========================================================================
  // Grapheme helpers (per-row storage, keyed by column)
  // Indexed by PHYSICAL row (rowGraphemes[physRow])
  // =========================================================================

  /** Get grapheme map for external read access (renderer uses this for grapheme lookup). */
  getGraphemeByIndex(idx: number): string | undefined {
    const physRow = Math.floor(idx / this.physCols);
    const col = idx % this.physCols;
    return this.getGraphemePhys(physRow, col);
  }

  /** Get grapheme by physical row and column. */
  private getGraphemePhys(physRow: number, col: number): string | undefined {
    return this.rowGraphemes[physRow]?.get(col);
  }

  /** Set grapheme by physical row and column. */
  private setGraphemePhys(physRow: number, col: number, value: string): void {
    let map = this.rowGraphemes[physRow];
    if (!map) {
      map = new Map();
      this.rowGraphemes[physRow] = map;
    }
    map.set(col, value);
  }

  /** Delete grapheme by physical row and column. */
  private deleteGraphemePhys(physRow: number, col: number): void {
    const map = this.rowGraphemes[physRow];
    if (!map) return;
    map.delete(col);
    if (map.size === 0) this.rowGraphemes[physRow] = null;
  }

  /** Check if a physical row has any graphemes. */
  private physRowHasGraphemes(physRow: number): boolean {
    return this.rowGraphemes[physRow] !== null;
  }

  /** Clear all graphemes for a physical row. */
  private clearPhysRowGraphemes(physRow: number): void {
    this.rowGraphemes[physRow] = null;
  }

  // =========================================================================
  // Row operations (used by Screen for scroll, erase, insert/delete)
  // =========================================================================

  /** Erase cells in a range within a single row. */
  eraseRange(row: number, startCol: number, endCol: number, bg: Color = DEFAULT_COLOR): void {
    const offset = this.activeRowMap[row] * this.physCols;
    const start = offset + startCol;
    const end = offset + Math.min(endCol, this.cols);
    const page = this.activePage;
    page.chars.fill(0, start, end);
    page.fg.fill(DEFAULT_COLOR, start, end);
    page.bg.fill(bg, start, end);
    page.attrs.fill(0, start, end);
    page.ulColor.fill(DEFAULT_COLOR, start, end);
    page.url.fill(0, start, end);
    // Clear graphemes in the erased range (use physical row)
    const physRow = this.activeRowMap[row];
    if (this.physRowHasGraphemes(physRow)) {
      const map = this.rowGraphemes[physRow]!;
      for (let c = startCol; c < Math.min(endCol, this.cols); c++) {
        map.delete(c);
      }
      if (map.size === 0) this.rowGraphemes[physRow] = null;
    }
    this.markDirty(row);
  }

  /** Clear a row to blanks with the given background color. */
  clearRow(row: number, bg: Color = DEFAULT_COLOR): void {
    const offset = this.activeRowMap[row] * this.physCols;
    const page = this.activePage;
    page.chars.fill(0, offset, offset + this.cols);
    page.fg.fill(DEFAULT_COLOR, offset, offset + this.cols);
    page.bg.fill(bg, offset, offset + this.cols);
    page.attrs.fill(0, offset, offset + this.cols);
    page.ulColor.fill(DEFAULT_COLOR, offset, offset + this.cols);
    page.url.fill(0, offset, offset + this.cols);
    this.clearPhysRowGraphemes(this.activeRowMap[row]);
    this.softWrapped[this.activeRowMap[row]] = 0;
    this.activePromptMark[this.activeRowMap[row]] = 0;
    this.markDirty(row);
  }

  /** Push the top row of a range into scrollback, shift rows up, blank the bottom.
   *  I6: Zero-copy scroll — rotate rowMap indices instead of copying cell data. */
  scrollUp(top: number, bottom: number, bg: Color = DEFAULT_COLOR): void {
    if (!this.isAlt && top === 0) {
      this.pushScrollback(top);
    }

    // I6: Save the physical row index that's being scrolled out
    const freedPhysRow = this.activeRowMap[top];

    // Shift rowMap entries up: row[top] = row[top+1], row[top+1] = row[top+2], ...
    this.activeRowMap.copyWithin(top, top + 1, bottom + 1);

    // The freed physical row becomes the new bottom row
    this.activeRowMap[bottom] = freedPhysRow;

    // Clear the physical row that is now at the bottom
    this.clearRow(bottom, bg);

    // Mark all affected rows dirty
    for (let r = top; r <= bottom; r++) this.markDirty(r);
  }

  /** Insert blank cells at (row, col), shifting existing cells right. Cells past cols are lost. */
  insertCells(row: number, col: number, count: number, bg: Color = DEFAULT_COLOR): void {
    const offset = this.activeRowMap[row] * this.physCols;
    const page = this.activePage;
    const src = offset + col;
    const dst = offset + col + count;
    const end = offset + this.cols;
    // Shift cells right (copyWithin handles overlapping correctly)
    if (dst < end) {
      page.chars.copyWithin(dst, src, end - count);
      page.fg.copyWithin(dst, src, end - count);
      page.bg.copyWithin(dst, src, end - count);
      page.attrs.copyWithin(dst, src, end - count);
      page.ulColor.copyWithin(dst, src, end - count);
    }
    // Fill inserted positions with blanks
    const fillEnd = Math.min(src + count, end);
    page.chars.fill(0, src, fillEnd);
    page.fg.fill(DEFAULT_COLOR, src, fillEnd);
    page.bg.fill(bg, src, fillEnd);
    page.attrs.fill(0, src, fillEnd);
    page.ulColor.fill(DEFAULT_COLOR, src, fillEnd);
    // Shift graphemes in this row (use physical row)
    const physRow = this.activeRowMap[row];
    if (this.physRowHasGraphemes(physRow)) {
      const map = this.rowGraphemes[physRow]!;
      const newMap = new Map<number, string>();
      for (const [c, g] of map) {
        if (c >= col) {
          const nc = c + count;
          if (nc < this.cols) newMap.set(nc, g);
        } else {
          newMap.set(c, g);
        }
      }
      this.rowGraphemes[physRow] = newMap.size > 0 ? newMap : null;
    }
    this.markDirty(row);
  }

  /** Delete cells at (row, col), shifting remaining cells left. Trailing cells are blanked. */
  deleteCells(row: number, col: number, count: number, bg: Color = DEFAULT_COLOR): void {
    const offset = this.activeRowMap[row] * this.physCols;
    const page = this.activePage;
    const dst = offset + col;
    const src = offset + col + count;
    const end = offset + this.cols;
    // Shift cells left
    if (src < end) {
      page.chars.copyWithin(dst, src, end);
      page.fg.copyWithin(dst, src, end);
      page.bg.copyWithin(dst, src, end);
      page.attrs.copyWithin(dst, src, end);
      page.ulColor.copyWithin(dst, src, end);
    }
    // Blank trailing positions
    const fillStart = Math.max(dst, end - count);
    page.chars.fill(0, fillStart, end);
    page.fg.fill(DEFAULT_COLOR, fillStart, end);
    page.bg.fill(bg, fillStart, end);
    page.attrs.fill(0, fillStart, end);
    page.ulColor.fill(DEFAULT_COLOR, fillStart, end);
    // Shift graphemes left in this row (use physical row)
    const physRow = this.activeRowMap[row];
    if (this.physRowHasGraphemes(physRow)) {
      const map = this.rowGraphemes[physRow]!;
      const newMap = new Map<number, string>();
      for (const [c, g] of map) {
        if (c < col) {
          newMap.set(c, g);
        } else if (c >= col + count) {
          newMap.set(c - count, g);
        }
        // graphemes in [col, col+count) are deleted — just skip them
      }
      this.rowGraphemes[physRow] = newMap.size > 0 ? newMap : null;
    }
    this.markDirty(row);
  }

  /** Fill a range of cells with a single character + attributes. Used by DECALN, etc. */
  fillCells(char: string, fg: Color, bg: Color, attrs: number, ulColor: Color,
            startRow = 0, startCol = 0, endRow = this.rows, endCol = this.cols): void {
    const cp = char.length === 0 ? 0 : char.codePointAt(0)!;
    const page = this.activePage;
    for (let r = startRow; r < endRow; r++) {
      const offset = this.activeRowMap[r] * this.physCols;
      const cStart = r === startRow ? startCol : 0;
      const cEnd = r === endRow - 1 ? endCol : this.cols;
      page.chars.fill(cp, offset + cStart, offset + cEnd);
      page.fg.fill(fg, offset + cStart, offset + cEnd);
      page.bg.fill(bg, offset + cStart, offset + cEnd);
      page.attrs.fill(attrs, offset + cStart, offset + cEnd);
      page.ulColor.fill(ulColor, offset + cStart, offset + cEnd);
      page.url.fill(0, offset + cStart, offset + cEnd);
      this.clearPhysRowGraphemes(this.activeRowMap[r]);
      this.markDirty(r);
    }
  }

  /** Shift rows down within a range, blank the top.
   *  I6: Zero-copy scroll — rotate rowMap indices instead of copying cell data. */
  scrollDown(top: number, bottom: number, bg: Color = DEFAULT_COLOR): void {
    // I6: Save the physical row index that's being scrolled out
    const freedPhysRow = this.activeRowMap[bottom];

    // Shift rowMap entries down: row[bottom] = row[bottom-1], ...
    // copyWithin(dst, src, srcEnd) — shift [top..bottom-1] to [top+1..bottom]
    // We must iterate backwards to avoid overwriting, but copyWithin doesn't
    // work well for shifting right in-place. Instead, manually shift.
    for (let r = bottom; r > top; r--) {
      this.activeRowMap[r] = this.activeRowMap[r - 1];
    }

    // The freed physical row becomes the new top row
    this.activeRowMap[top] = freedPhysRow;

    // Clear the physical row that is now at the top
    this.clearRow(top, bg);

    // Mark all affected rows dirty
    for (let r = top; r <= bottom; r++) this.markDirty(r);
  }

  // =========================================================================
  // Alt screen
  // =========================================================================

  /** Switch to alternate screen buffer. */
  switchToAlt(): void {
    if (this.isAlt) return;
    this.isAlt = true;
    this.activePage = this.altPage;
    this.activeRowMap = this.altRowMap;
    this.markAllDirty();
  }

  /** Switch back to main screen buffer. */
  switchToMain(): void {
    if (!this.isAlt) return;
    this.isAlt = false;
    this.activePage = this.mainPage;
    this.activeRowMap = this.mainRowMap;
    this.markAllDirty();
  }

  get isAlternate(): boolean {
    return this.isAlt;
  }

  /** Full reset — clear both pages, grapheme map, scrollback, switch to main. */
  resetAll(): void {
    this.mainPage.chars.fill(0); this.mainPage.fg.fill(0);
    this.mainPage.bg.fill(0); this.mainPage.attrs.fill(0); this.mainPage.ulColor.fill(0); this.mainPage.url.fill(0);
    this.altPage.chars.fill(0); this.altPage.fg.fill(0);
    this.altPage.bg.fill(0); this.altPage.attrs.fill(0); this.altPage.ulColor.fill(0); this.altPage.url.fill(0);
    this.urlTable = [];
    this.urlByStr.clear();
    this.sbPromptMark.fill(0);
    this.activePromptMark.fill(0);
    // Reset both rowMaps to identity
    this.resetRowMap(this.mainRowMap);
    this.resetRowMap(this.altRowMap);
    // Clear all graphemes and soft-wrap flags (physRows entries)
    this.rowGraphemes.fill(null);
    this.softWrapped.fill(0);
    this.sbHead = 0;
    this.sbCount = 0;
    this.sbSoftWrapped.fill(0);
    this.isAlt = false;
    this.activePage = this.mainPage;
    this.activeRowMap = this.mainRowMap;
    this.markAllDirty();
  }

  // =========================================================================
  // Scrollback (ring buffer)
  // =========================================================================

  pushScrollback(row: number): void {
    const cols = this.cols;
    // I6: Source row offset uses rowMap indirection
    const offset = this.activeRowMap[row] * this.physCols;
    const page = this.activePage;

    // Compute the physical slot in the ring
    const slot = (this.sbHead + this.sbCount) % this.scrollbackLimit;
    const sbOff = slot * this.sbCols;

    // Copy cell data into the ring buffer slot
    // If cols changed since allocation, only copy what fits
    const copyCols = Math.min(cols, this.sbCols);
    this.sbChars.set(page.chars.subarray(offset, offset + copyCols), sbOff);
    this.sbFg.set(page.fg.subarray(offset, offset + copyCols), sbOff);
    this.sbBg.set(page.bg.subarray(offset, offset + copyCols), sbOff);
    // 4.2: Pack attrs from Uint32 → Uint16 (only 12 bits used)
    for (let c = 0; c < copyCols; c++) {
      this.sbAttrs[sbOff + c] = page.attrs[offset + c];
    }

    // Clear any extra columns in the slot (if sbCols > cols after resize)
    if (copyCols < this.sbCols) {
      this.sbChars.fill(0, sbOff + copyCols, sbOff + this.sbCols);
      this.sbFg.fill(0, sbOff + copyCols, sbOff + this.sbCols);
      this.sbBg.fill(0, sbOff + copyCols, sbOff + this.sbCols);
      this.sbAttrs.fill(0, sbOff + copyCols, sbOff + this.sbCols);
    }

    // Materialize grapheme sentinels into actual codepoints
    const physRow = this.activeRowMap[row];
    if (this.physRowHasGraphemes(physRow)) {
      const map = this.rowGraphemes[physRow]!;
      for (const [c, g] of map) {
        if (c < copyCols && this.sbChars[sbOff + c] === GRAPHEME_SENTINEL) {
          this.sbChars[sbOff + c] = (g && g.length > 0) ? g.codePointAt(0)! : 0;
        }
      }
    }

    // Copy prompt mark and soft-wrap flag for this row to the scrollback slot
    this.sbPromptMark[slot] = this.activePromptMark[physRow];
    this.sbSoftWrapped[slot] = this.softWrapped[physRow];

    if (this.sbCount < this.scrollbackLimit) {
      this.sbCount++;
    } else {
      // Ring is full — advance head (oldest row is overwritten)
      this.sbHead = (this.sbHead + 1) % this.scrollbackLimit;
    }
  }

  get scrollbackLength(): number {
    return this.sbCount;
  }

  /** Return a row from scrollback as a plain string (one char per cell, space for empty).
   *  scrollRow 0 = oldest row. Used by the search engine. */
  getScrollbackRowText(scrollRow: number): string {
    if (scrollRow < 0 || scrollRow >= this.sbCount) return "";
    const physRow = (this.sbHead + scrollRow) % this.scrollbackLimit;
    const base = physRow * this.sbCols;
    const cols = Math.min(this.cols, this.sbCols);
    let text = "";
    for (let c = 0; c < cols; c++) {
      const cp = this.sbChars[base + c];
      text += cp === 0 ? " " : String.fromCodePoint(cp);
    }
    return text;
  }

  /** Return an active-buffer row as a plain string (one entry per cell, space for empty).
   *  Used by the search engine. */
  getActiveRowText(row: number): string {
    if (row < 0 || row >= this.rows) return "";
    const physRow = this.activeRowMap[row];
    const offset = physRow * this.physCols;
    const page = this.activePage;
    let text = "";
    for (let c = 0; c < this.cols; c++) {
      const cp = page.chars[offset + c];
      if (cp === 0) {
        text += " ";
      } else if (cp === GRAPHEME_SENTINEL) {
        text += this.getGraphemePhys(physRow, c) ?? " ";
      } else {
        text += String.fromCodePoint(cp);
      }
    }
    return text;
  }

  // =========================================================================
  // OSC 8 URL storage
  // =========================================================================

  /** Intern a URL string and return a stable 1-indexed ID (0 reserved for "no URL"). */
  internUrl(url: string): number {
    let id = this.urlByStr.get(url);
    if (id === undefined) {
      id = this.urlTable.length + 1;
      this.urlTable.push(url);
      this.urlByStr.set(url, id);
    }
    return id;
  }

  /** Write a URL ID to a single cell in the active buffer. */
  setUrl(row: number, col: number, urlId: number): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    this.activePage.url[this.activeRowMap[row] * this.physCols + col] = urlId;
  }

  /** Read the URL ID at a cell in the active buffer (0 = no URL). */
  getUrlId(row: number, col: number): number {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return 0;
    return this.activePage.url[this.activeRowMap[row] * this.physCols + col];
  }

  /** Resolve a URL ID to its string ("" if id is 0 or unknown). */
  getUrlStr(id: number): string {
    return id > 0 ? (this.urlTable[id - 1] ?? "") : "";
  }

  /** Get URL string at a cell in the active buffer, or null if none. */
  getUrlAt(row: number, col: number): string | null {
    const id = this.getUrlId(row, col);
    if (id === 0) return null;
    return this.urlTable[id - 1] ?? null;
  }

  // =========================================================================
  // OSC 133 prompt marks
  // =========================================================================

  /** Set the prompt mark for a logical active-buffer row. */
  setPromptMark(row: number, mark: number): void {
    if (row < 0 || row >= this.rows) return;
    this.activePromptMark[this.activeRowMap[row]] = mark;
  }

  /** Get the prompt mark for a logical active-buffer row (0 = none). */
  getPromptMark(row: number): number {
    if (row < 0 || row >= this.rows) return 0;
    return this.activePromptMark[this.activeRowMap[row]];
  }

  /** Get the prompt mark for a scrollback row (scrollRow 0 = oldest; 0 = none). */
  getScrollbackPromptMark(scrollRow: number): number {
    if (scrollRow < 0 || scrollRow >= this.sbCount) return 0;
    return this.sbPromptMark[(this.sbHead + scrollRow) % this.scrollbackLimit];
  }

  trimScrollback(): void {
    // Ring buffer handles its own limit — nothing to do
  }

  clearScrollback(): void {
    this.sbHead = 0;
    this.sbCount = 0;
  }

  // =========================================================================
  // Dirty tracking (I9: sub-row column ranges)
  // =========================================================================

  /** Mark a full row as dirty. */
  private markDirty(row: number): void {
    this.dirtyBitmap[row] = 1;
    this.dirtyColStart[row] = 0;
    this.dirtyColEnd[row] = this.cols;
  }

  /** Mark a single cell as dirty, expanding the dirty column range (I9). */
  private markDirtyCell(row: number, col: number): void {
    if (this.dirtyBitmap[row]) {
      // Already dirty — expand the range
      if (col < this.dirtyColStart[row]) this.dirtyColStart[row] = col;
      if (col + 1 > this.dirtyColEnd[row]) this.dirtyColEnd[row] = col + 1;
    } else {
      // Not dirty yet — set initial range
      this.dirtyBitmap[row] = 1;
      this.dirtyColStart[row] = col;
      this.dirtyColEnd[row] = col + 1;
    }
  }

  /** Mark all rows as dirty (resize, buffer switch, DPR change). */
  markAllDirty(): void {
    this.dirtyBitmap.fill(1, 0, this.rows);
    this.dirtyColStart.fill(0, 0, this.rows);
    for (let r = 0; r < this.rows; r++) {
      this.dirtyColEnd[r] = this.cols;
    }
  }

  /** Clear the dirty bitmap after rendering.
   *  Only clears [0, rows) — colStart/colEnd reset not needed since only read when bitmap=1. */
  clearDirty(): void {
    this.dirtyBitmap.fill(0, 0, this.rows);
  }

  // =========================================================================
  // Resize (I10: oversized buffer — only reallocate when exceeded)
  // =========================================================================

  resize(newCols: number, newRows: number): void {
    const needPhysCols = Math.max(newCols, MIN_PHYS_COLS);
    const needPhysRows = Math.max(newRows, MIN_PHYS_ROWS);

    if (needPhysCols <= this.physCols && needPhysRows <= this.physRows) {
      // I10: No reallocation needed — physical buffer is large enough.
      // If cols changed, we need to repack rows since stride changes.
      if (newCols !== this.cols) {
        // Column count changed but fits within physCols.
        // The stride is physCols (unchanged), and each row still has physCols
        // worth of space. We just need to clear any cells in columns beyond
        // newCols for rows that had data there (or just mark dirty).
        // Since stride is physCols (not cols), rows are already correctly spaced.
        // Just update logical dims.
      }

      // Repack cell data to match identity row mapping before resetting.
      // After scrolling, the row map is rotated so physical rows are out of
      // order.  Resetting to identity without moving data scrambles the display.
      const copyRows = Math.min(this.rows, newRows);
      this.repackPageToIdentity(this.mainPage, this.mainRowMap, copyRows, Math.min(this.cols, newCols));
      this.repackPageToIdentity(this.altPage, this.altRowMap, copyRows, Math.min(this.cols, newCols));

      this.cols = newCols;
      this.rows = newRows;

      // Rebuild rowMaps to identity (both main and alt)
      this.resetRowMap(this.mainRowMap);
      this.resetRowMap(this.altRowMap);
      this.activeRowMap = this.isAlt ? this.altRowMap : this.mainRowMap;

      // Prompt marks: clear on resize (rowMap reset to identity invalidates physical-row mapping)
      this.activePromptMark.fill(0);

      // Rebuild dirty tracking for new row count
      this.markAllDirty();
    } else {
      // Need to grow physical buffer — grow to max(requested*2, current)
      const newPhysCols = Math.max(needPhysCols, this.physCols, newCols * 2);
      const newPhysRows = Math.max(needPhysRows, this.physRows, newRows * 2);

      const resizePage = (oldPage: BufferPage): BufferPage => {
        const newPage = this.makePage(newPhysCols, newPhysRows);
        const copyRows = Math.min(this.rows, newRows);
        const copyCols = Math.min(this.cols, newCols);
        for (let r = 0; r < copyRows; r++) {
          // Source uses old rowMap for indirection, old physCols stride
          const sOff = this.activeRowMap[r] * this.physCols;
          // Destination uses identity mapping, new physCols stride
          const dOff = r * newPhysCols;
          newPage.chars.set(oldPage.chars.subarray(sOff, sOff + copyCols), dOff);
          newPage.fg.set(oldPage.fg.subarray(sOff, sOff + copyCols), dOff);
          newPage.bg.set(oldPage.bg.subarray(sOff, sOff + copyCols), dOff);
          newPage.attrs.set(oldPage.attrs.subarray(sOff, sOff + copyCols), dOff);
          newPage.ulColor.set(oldPage.ulColor.subarray(sOff, sOff + copyCols), dOff);
          newPage.url.set(oldPage.url.subarray(sOff, sOff + copyCols), dOff);
        }
        return newPage;
      };

      // Resize main page (use mainRowMap for source indirection)
      const savedActiveRowMap = this.activeRowMap;
      this.activeRowMap = this.mainRowMap;
      this.mainPage = resizePage(this.mainPage);
      this.activeRowMap = this.altRowMap;
      this.altPage = resizePage(this.altPage);
      this.activeRowMap = savedActiveRowMap;

      // Rebuild per-row graphemes array for new physical row count
      // Map old physical rows to new identity-mapped rows
      const oldGraphemes = this.rowGraphemes;
      this.rowGraphemes = new Array(newPhysRows).fill(null);
      const keepRows = Math.min(this.rows, newRows);
      for (let r = 0; r < keepRows; r++) {
        // Old physical row via old rowMap
        const oldPhysRow = savedActiveRowMap[r];
        const map = oldGraphemes[oldPhysRow];
        if (!map) continue;
        if (newCols >= this.cols) {
          // No columns lost — keep the map as-is, assign to new physical row (identity = r)
          this.rowGraphemes[r] = map;
        } else {
          // Prune columns that are now out of bounds
          const pruned = new Map<number, string>();
          for (const [c, g] of map) {
            if (c < newCols) pruned.set(c, g);
          }
          this.rowGraphemes[r] = pruned.size > 0 ? pruned : null;
        }
      }

      this.physCols = newPhysCols;
      this.physRows = newPhysRows;
      this.cols = newCols;
      this.rows = newRows;

      this.activePage = this.isAlt ? this.altPage : this.mainPage;

      // Allocate new rowMaps and reset to identity
      this.mainRowMap = new Uint16Array(newPhysRows);
      this.altRowMap = new Uint16Array(newPhysRows);
      this.resetRowMap(this.mainRowMap);
      this.resetRowMap(this.altRowMap);
      this.activeRowMap = this.isAlt ? this.altRowMap : this.mainRowMap;

      // Prompt marks: allocate fresh (marks lost on physical-layout change)
      this.activePromptMark = new Uint8Array(newPhysRows);

      // Rebuild dirty tracking arrays for new physRows
      this.dirtyBitmap = new Uint8Array(newPhysRows);
      this.dirtyColStart = new Uint16Array(newPhysRows);
      this.dirtyColEnd = new Uint16Array(newPhysRows);
      this.markAllDirty();
    }

    // If cols changed, reallocate the scrollback ring buffer.
    // Scrollback content is lost on col change — reflow of scrollback would
    // require reconstructing logical lines from the ring buffer, which is
    // tracked via sbSoftWrapped but not yet implemented for the ring itself.
    if (newCols !== this.sbCols) {
      this.sbCols = newCols;
      const sbSize = this.scrollbackLimit * newCols;
      this.sbChars = new Uint32Array(sbSize);
      this.sbFg = new Uint32Array(sbSize);
      this.sbBg = new Uint32Array(sbSize);
      this.sbAttrs = new Uint16Array(sbSize);
      this.sbHead = 0;
      this.sbCount = 0;
      this.sbPromptMark.fill(0);
      this.sbSoftWrapped.fill(0);
    }
  }

  // =========================================================================
  // Typed array accessors (for direct renderer access)
  // =========================================================================

  get activeChars(): Uint32Array { return this.activePage.chars; }
  get activeFg(): Uint32Array { return this.activePage.fg; }
  get activeBg(): Uint32Array { return this.activePage.bg; }
  get activeAttrs(): Uint32Array { return this.activePage.attrs; }
  get activeUlColor(): Uint32Array { return this.activePage.ulColor; }
}
