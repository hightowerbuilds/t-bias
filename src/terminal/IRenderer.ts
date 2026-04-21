import type { Cell } from "./types";

// ---------------------------------------------------------------------------
// Render state — the data snapshot a renderer consumes
// ---------------------------------------------------------------------------

export interface CursorState {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly shape: "block" | "underline" | "bar";
}

export interface SelectionBounds {
  readonly startCol: number;
  readonly startRow: number;
  readonly endCol: number;
  readonly endRow: number;
}

/**
 * RenderState for the text layer only.
 * Cursor and selection live on separate canvas layers managed by the host.
 *
 * Renderers can use getCell() for compatibility, or read typed arrays directly
 * for zero-allocation high-performance rendering.
 */
/** Per-row typed-array source — tells the renderer which arrays + offset to use. */
export interface RowSource {
  readonly chars: Uint32Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  /** Uint32Array for active screen, Uint16Array for scrollback (12-bit attrs). */
  readonly attrs: Uint32Array | Uint16Array;
  readonly ulColor: Uint32Array | null;  // null for scrollback (always DEFAULT_COLOR)
  readonly offset: number;
  readonly getGrapheme: ((idx: number) => string | undefined) | null;
}

export interface RenderState {
  readonly cols: number;
  readonly rows: number;
  /** Compatibility accessor — allocates a Cell object per call. */
  getCell(row: number, col: number): Cell;
  readonly viewportOffset: number;
  /** Bitmap of which rows have changed since last draw (1 = dirty). */
  readonly dirtyRows: Uint8Array;
  // --- Direct typed-array access (zero-allocation, active screen only) ---
  readonly chars: Uint32Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  readonly attrs: Uint32Array;
  readonly ulColor: Uint32Array;
  readonly getGrapheme: (idx: number) => string | undefined;
  /** Get the byte offset into typed arrays for a logical row (row indirection). */
  readonly rowOffset: (row: number) => number;
  /** Sub-row dirty column range (only valid when dirtyRows[row] is set). */
  readonly dirtyColStart: Uint16Array;
  readonly dirtyColEnd: Uint16Array;
  /** Viewport-aware row source — returns the correct typed arrays + offset
   *  for a visible row, whether it's from scrollback or the active screen. */
  readonly getRowSource: (row: number) => RowSource;
}

// ---------------------------------------------------------------------------
// Terminal modes — read-only flags the host queries from the core
// ---------------------------------------------------------------------------

export interface TerminalModes {
  readonly applicationCursor: boolean;
  readonly bracketedPaste: boolean;
  readonly mouseEnabled: boolean;
  readonly mouseSgr: boolean;
  readonly mouseDrag: boolean;
  readonly mouseAll: boolean;
  readonly isAlternateScreen: boolean;
  readonly focusEvents: boolean;
  readonly alternateScroll: boolean;
}

// ---------------------------------------------------------------------------
// Renderer interface — any rendering backend implements this
// ---------------------------------------------------------------------------

export interface IRenderer {
  draw(state: RenderState): void;
  resize(cols: number, rows: number): void;
  setFontSize(size: number): void;
  gridSize(widthPx: number, heightPx: number): { cols: number; rows: number };
  readonly cellWidth: number;
  readonly cellHeight: number;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Render metrics — exposed by the renderer for performance monitoring
// ---------------------------------------------------------------------------

export interface RenderMetrics {
  drawTimeMs: number;
  dirtyRows: number;
  atlasSize: number;
  atlasPages: number;
  atlasHitRate: number; // 0-1
}
