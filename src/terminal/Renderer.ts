import { prepare, layout } from "@chenglou/pretext";
import type { IRenderer, RenderState, RenderMetrics } from "./IRenderer";
import { GlyphAtlas } from "./GlyphAtlas";
import {
  type Color, type Theme,
  DEFAULT_THEME, DEFAULT_COLOR,
  isDefault, isPalette, isRgb, paletteIndex, rgbR, rgbG, rgbB,
  palette256, ulStyle,
  BOLD, FAINT, ITALIC, INVERSE, HIDDEN, STRIKETHROUGH, OVERLINE, WIDE,
} from "./types";

export class CanvasRenderer implements IRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private theme: Theme;
  private dpr: number;

  // Font config
  private fontSize: number;
  private fontFamily: string;
  private baseFont: string;
  private boldFont: string;
  private italicFont: string;
  private boldItalicFont: string;

  // Cell metrics (measured via Pretext)
  cellWidth = 0;
  cellHeight = 0;
  private baseline = 0;

  // Glyph atlas
  private atlas: GlyphAtlas;

  // DPR change detection
  private dprMediaQuery: MediaQueryList | null = null;
  private dprChangeCallback: (() => void) | null = null;
  onDprChange?: () => void; // Host can listen to trigger re-fit

  // Dirty tracking: VirtualCanvas provides the dirty bitmap;
  // forceFullDraw is a local override for resize/DPR/font changes.
  private forceFullDraw = true;

  // Render metrics
  private _lastDrawTime = 0;
  private _lastDirtyRows = 0;

  get lastDrawTime(): number { return this._lastDrawTime; }
  get lastDirtyRows(): number { return this._lastDirtyRows; }
  get atlasSize(): number { return this.atlas.size; }
  get atlasPages(): number { return this.atlas.pageCount; }
  get atlasHits(): number { return this.atlas.hits; }
  get atlasMisses(): number { return this.atlas.misses; }
  resetAtlasMetrics() { this.atlas.resetMetrics(); }

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      fontSize?: number;
      fontFamily?: string;
      theme?: Theme;
    } = {}
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.dpr = window.devicePixelRatio || 1;
    this.fontSize = options.fontSize ?? 14;
    this.fontFamily =
      options.fontFamily ?? "Menlo, Monaco, 'Courier New', monospace";
    this.theme = options.theme ?? DEFAULT_THEME;

    this.baseFont = `${this.fontSize}px ${this.fontFamily}`;
    this.boldFont = `bold ${this.fontSize}px ${this.fontFamily}`;
    this.italicFont = `italic ${this.fontSize}px ${this.fontFamily}`;
    this.boldItalicFont = `bold italic ${this.fontSize}px ${this.fontFamily}`;

    this.measureCellMetrics();

    this.atlas = new GlyphAtlas(
      this.cellWidth, this.cellHeight, this.baseline, this.dpr,
      this.fontSize, this.fontFamily,
    );

    this.watchDpr();
  }

  private measureCellMetrics() {
    const ref = "MMMMMMMMMM";
    const lineHeight = Math.ceil(this.fontSize * 1.2);
    const prepared = prepare(ref, this.baseFont, { whiteSpace: "pre-wrap" });
    layout(prepared, Infinity, lineHeight);

    this.ctx.font = this.baseFont;
    const metrics = this.ctx.measureText("M");

    // Pixel-snap cell dimensions for fractional DPR (1.25, 1.5, etc.)
    // Round physical-pixel dimensions to integers, then derive logical size.
    // This avoids subpixel blending artifacts at cell boundaries.
    const rawWidth = metrics.width;
    const rawHeight = lineHeight;
    const dpr = this.dpr;

    this.cellWidth = Math.round(rawWidth * dpr) / dpr;
    this.cellHeight = Math.round(rawHeight * dpr) / dpr;
    this.baseline = metrics.actualBoundingBoxAscent ?? this.fontSize * 0.8;
  }

  /** Watch for DPR changes (window moved to a different display). */
  private watchDpr() {
    this.unwatchDpr();
    const mq = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprChangeCallback = () => {
      const newDpr = window.devicePixelRatio || 1;
      if (newDpr !== this.dpr) {
        this.dpr = newDpr;
        this.measureCellMetrics();
        this.atlas.updateMetrics(
          this.cellWidth, this.cellHeight, this.baseline, this.dpr,
          this.fontSize, this.fontFamily,
        );
        this.forceFullDraw = true;
        this.watchDpr(); // re-register for the new DPR value
        this.onDprChange?.();
      }
    };
    mq.addEventListener("change", this.dprChangeCallback);
    this.dprMediaQuery = mq;
  }

  private unwatchDpr() {
    if (this.dprMediaQuery && this.dprChangeCallback) {
      this.dprMediaQuery.removeEventListener("change", this.dprChangeCallback);
    }
    this.dprMediaQuery = null;
    this.dprChangeCallback = null;
  }

  gridSize(widthPx: number, heightPx: number): { cols: number; rows: number } {
    return {
      cols: Math.max(1, Math.floor(widthPx / this.cellWidth)),
      rows: Math.max(1, Math.floor(heightPx / this.cellHeight)),
    };
  }

  resize(cols: number, rows: number) {
    const width = cols * this.cellWidth;
    const height = rows * this.cellHeight;
    this.canvas.width = Math.ceil(width * this.dpr);
    this.canvas.height = Math.ceil(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.forceFullDraw = true;
  }

  setFontSize(size: number) {
    this.fontSize = size;
    this.baseFont = `${size}px ${this.fontFamily}`;
    this.boldFont = `bold ${size}px ${this.fontFamily}`;
    this.italicFont = `italic ${size}px ${this.fontFamily}`;
    this.boldItalicFont = `bold italic ${size}px ${this.fontFamily}`;
    this.measureCellMetrics();
    this.atlas.updateMetrics(
      this.cellWidth, this.cellHeight, this.baseline, this.dpr,
      this.fontSize, this.fontFamily,
    );
    this.forceFullDraw = true;
  }

  /** Switch to a new canvas element, preserving the glyph atlas and metrics. */
  reattach(canvas: HTMLCanvasElement) {
    this.unwatchDpr();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.dpr = window.devicePixelRatio || 1;
    this.forceFullDraw = true;
    this.watchDpr();
  }

  dispose() {
    this.unwatchDpr();
  }

  // =========================================================================
  // Main draw
  // =========================================================================

  draw(state: RenderState) {
    const t0 = performance.now();
    const { cols, rows } = state;
    const { cellWidth, cellHeight, ctx, theme } = this;
    const bitmap = state.dirtyRows;
    const scrolled = state.viewportOffset > 0;

    // --- Count dirty rows from the VirtualCanvas bitmap ---
    // When scrolled into scrollback, dirty bitmap doesn't apply — always full redraw.
    const fullRedraw = this.forceFullDraw || scrolled;
    this.forceFullDraw = false;
    let dirtyCount = 0;

    if (fullRedraw) {
      dirtyCount = rows;
    } else {
      for (let r = 0; r < rows; r++) {
        if (bitmap[r]) dirtyCount++;
      }
    }

    if (dirtyCount === 0) {
      this._lastDrawTime = performance.now() - t0;
      this._lastDirtyRows = 0;
      return;
    }

    this._lastDirtyRows = dirtyCount;

    // --- Clear ---
    // partialRedraw: few dirty rows → clear only those rows' dirty columns.
    // Otherwise (fullRedraw OR many dirty rows): full canvas clear + draw ALL rows.
    const partialRedraw = !fullRedraw && dirtyCount <= rows / 2;
    const drawAllRows = fullRedraw || !partialRedraw;
    if (!partialRedraw) {
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, cols * cellWidth, rows * cellHeight);
    }

    // --- Draw rows ---
    for (let row = 0; row < rows; row++) {
      if (!drawAllRows && !bitmap[row]) continue;
      const y = row * cellHeight;

      // Get the correct typed-array source for this row (scrollback or active).
      const src = state.getRowSource(row);

      // Sub-row dirty column range — only use sub-ranges in partial mode.
      // In full-clear mode, non-dirty rows need full-width redraw since
      // the canvas was wiped; dirty rows also use full width for safety.
      const colStart = partialRedraw ? state.dirtyColStart[row] : 0;
      const colEnd = partialRedraw ? state.dirtyColEnd[row] : cols;

      if (partialRedraw) {
        ctx.fillStyle = theme.background;
        ctx.fillRect(colStart * cellWidth, y, (colEnd - colStart) * cellWidth, cellHeight);
      }

      // --- Pass 1: Backgrounds with run merging ---
      this.drawRowBackgrounds(src, colStart, colEnd, y, cols);

      // --- Pass 2: Glyphs from atlas ---
      this.drawRowGlyphs(src, colStart, colEnd, y);

      // --- Pass 3: Decorations (underline, strikethrough, overline) ---
      this.drawRowDecorations(src, colStart, colEnd, y);
    }

    this._lastDrawTime = performance.now() - t0;
  }

  // =========================================================================
  // Pass 1: Backgrounds — run merging
  // =========================================================================

  private drawRowBackgrounds(src: import("./IRenderer").RowSource, colStart: number, colEnd: number, y: number, cols: number) {
    const { cellWidth, cellHeight, ctx, theme } = this;
    const offset = src.offset;
    let runStart = colStart;
    let runBg = theme.background;

    for (let col = colStart; col <= colEnd; col++) {
      let bg: string;

      if (col < colEnd) {
        const idx = offset + col;
        const a = src.attrs[idx];
        if (a & INVERSE) {
          bg = this.resolveColor(src.fg[idx], theme.foreground);
        } else {
          bg = this.resolveColor(src.bg[idx], theme.background);
        }
      } else {
        bg = ""; // sentinel to flush last run
      }

      if (bg !== runBg) {
        if (runBg !== theme.background && col > runStart) {
          ctx.fillStyle = runBg;
          ctx.fillRect(runStart * cellWidth, y, (col - runStart) * cellWidth, cellHeight);
        }
        runStart = col;
        runBg = bg;
      }
    }
  }

  // =========================================================================
  // Pass 2: Glyphs — atlas blitting
  // =========================================================================

  private drawRowGlyphs(src: import("./IRenderer").RowSource, colStart: number, colEnd: number, y: number) {
    const { cellWidth, cellHeight, ctx, theme } = this;
    const offset = src.offset;
    const GRAPHEME = 0xFFFFFFFF;

    for (let col = colStart; col < colEnd; col++) {
      const idx = offset + col;
      const cp = src.chars[idx];
      const a = src.attrs[idx];
      if (cp === 0 || (a & HIDDEN)) continue;

      // Resolve char string from codepoint or grapheme map
      const char = cp === GRAPHEME
        ? (src.getGrapheme?.(idx) ?? "")
        : String.fromCodePoint(cp);
      if (!char) continue;

      const wide = (a & WIDE) !== 0;
      const bold = (a & BOLD) !== 0;
      const italic = (a & ITALIC) !== 0;
      const faint = (a & FAINT) !== 0;

      let fg = this.resolveColor(src.fg[idx], theme.foreground);
      let bg = this.resolveColor(src.bg[idx], theme.background);
      if (a & INVERSE) [fg, bg] = [bg, fg];

      const { entry, source } = this.atlas.getTracked(char, bold, italic, faint, fg, wide);

      const dx = col * cellWidth;
      const dw = wide ? cellWidth * 2 : cellWidth;

      ctx.drawImage(
        source,
        entry.x, entry.y, entry.w, entry.h,
        dx, y, dw, cellHeight,
      );

      if (wide) col++;
    }
  }

  // =========================================================================
  // Pass 3: Decorations
  // =========================================================================

  private drawRowDecorations(src: import("./IRenderer").RowSource, colStart: number, colEnd: number, y: number) {
    const { cellWidth, cellHeight, ctx, theme } = this;
    const offset = src.offset;

    for (let col = colStart; col < colEnd; col++) {
      const idx = offset + col;
      const a = src.attrs[idx];
      const x = col * cellWidth;
      const wide = (a & WIDE) !== 0;
      const w = wide ? cellWidth * 2 : cellWidth;

      let fg = this.resolveColor(src.fg[idx], theme.foreground);
      if (a & INVERSE) {
        fg = this.resolveColor(src.bg[idx], theme.background);
      }

      // Underline
      const ul = ulStyle(a);
      if (ul > 0) {
        const ulc = src.ulColor ? src.ulColor[idx] : DEFAULT_COLOR;
        const ulColor = isDefault(ulc) ? fg : this.resolveColor(ulc, fg);
        ctx.strokeStyle = ulColor;
        ctx.lineWidth = 1;
        const ulY = y + cellHeight - 1;

        if (ul === 3) {
          this.drawCurly(ctx, x, ulY, w);
        } else if (ul === 2) {
          ctx.beginPath();
          ctx.moveTo(x, ulY - 2); ctx.lineTo(x + w, ulY - 2);
          ctx.moveTo(x, ulY); ctx.lineTo(x + w, ulY);
          ctx.stroke();
        } else {
          if (ul === 4) ctx.setLineDash([2, 2]);
          else if (ul === 5) ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(x, ulY); ctx.lineTo(x + w, ulY);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Strikethrough
      if (a & STRIKETHROUGH) {
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + cellHeight / 2);
        ctx.lineTo(x + w, y + cellHeight / 2);
        ctx.stroke();
      }

      // Overline
      if (a & OVERLINE) {
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + w, y);
        ctx.stroke();
      }

      if (wide) col++;
    }
  }

  // =========================================================================
  // Metrics
  // =========================================================================

  getMetrics(): RenderMetrics {
    const total = this.atlas.hits + this.atlas.misses;
    return {
      drawTimeMs: this._lastDrawTime,
      dirtyRows: this._lastDirtyRows,
      atlasSize: this.atlas.size,
      atlasPages: this.atlas.pageCount,
      atlasHitRate: total > 0 ? this.atlas.hits / total : 1,
    };
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  private resolveColor(color: Color, fallback: string): string {
    if (isDefault(color)) return fallback;
    if (isPalette(color)) {
      const idx = paletteIndex(color);
      if (idx < 16 && idx < this.theme.ansi.length) return this.theme.ansi[idx];
      const [r, g, b] = palette256(idx);
      return `rgb(${r},${g},${b})`;
    }
    return `rgb(${rgbR(color)},${rgbG(color)},${rgbB(color)})`;
  }

  private drawCurly(ctx: CanvasRenderingContext2D, x: number, y: number, w: number) {
    ctx.beginPath();
    for (let i = 0; i <= w; i++) {
      const py = y + Math.sin(i * (Math.PI / 4)) * 2;
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x + i, py);
    }
    ctx.stroke();
  }

}
