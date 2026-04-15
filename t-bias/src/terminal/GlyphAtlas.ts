// ---------------------------------------------------------------------------
// GlyphAtlas — dynamic texture atlas for cached glyph rendering
// ---------------------------------------------------------------------------
// Instead of calling fillText() per cell per frame (expensive: font resolution,
// shaping, rasterization every time), we rasterize each unique glyph once into
// an offscreen canvas and blit from it via drawImage() (a fast GPU texture copy).
//
// Architecture:
//   - Multiple atlas pages (OffscreenCanvas or regular Canvas, each PAGE_SIZE x PAGE_SIZE)
//   - Glyphs keyed by: character + font variant + foreground color
//   - Packed in rows by cell height
//   - LRU eviction when a page fills up

const PAGE_SIZE = 1024; // pixels per atlas page dimension

export interface GlyphEntry {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AtlasPage {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  cursorX: number; // next free x position in current row
  cursorY: number; // y position of current row
  rowHeight: number; // height of current row
}

export class GlyphAtlas {
  private pages: AtlasPage[] = [];
  private cache = new Map<string, GlyphEntry>();
  private lruOrder: string[] = []; // oldest first
  private cellWidth: number;
  private cellHeight: number;
  private baseline: number;
  private dpr: number;

  // Font strings
  private baseFont: string;
  private boldFont: string;
  private italicFont: string;
  private boldItalicFont: string;

  constructor(
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    dpr: number,
    fontSize: number,
    fontFamily: string,
  ) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.baseline = baseline;
    this.dpr = dpr;
    this.baseFont = `${fontSize}px ${fontFamily}`;
    this.boldFont = `bold ${fontSize}px ${fontFamily}`;
    this.italicFont = `italic ${fontSize}px ${fontFamily}`;
    this.boldItalicFont = `bold italic ${fontSize}px ${fontFamily}`;

    this.addPage();
  }

  /** Update metrics when font size changes. Clears the entire cache. */
  updateMetrics(
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    dpr: number,
    fontSize: number,
    fontFamily: string,
  ) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.baseline = baseline;
    this.dpr = dpr;
    this.baseFont = `${fontSize}px ${fontFamily}`;
    this.boldFont = `bold ${fontSize}px ${fontFamily}`;
    this.italicFont = `italic ${fontSize}px ${fontFamily}`;
    this.boldItalicFont = `bold italic ${fontSize}px ${fontFamily}`;
    this.clear();
  }

  /** Clear the entire atlas (e.g., on font size change or DPR change). */
  clear() {
    this.pages = [];
    this.cache.clear();
    this.lruOrder = [];
    this.addPage();
  }

  /**
   * Get a cached glyph entry, or rasterize and cache it.
   * Returns the entry and the canvas page to blit from.
   */
  get(
    char: string,
    bold: boolean,
    italic: boolean,
    faint: boolean,
    fgColor: string,
    wide: boolean,
  ): { entry: GlyphEntry; source: OffscreenCanvas | HTMLCanvasElement } {
    const key = this.makeKey(char, bold, italic, faint, fgColor, wide);

    const existing = this.cache.get(key);
    if (existing) {
      this.touchLru(key);
      return { entry: existing, source: this.pages[existing.page].canvas };
    }

    // Cache miss — rasterize
    const entry = this.rasterize(char, bold, italic, faint, fgColor, wide);
    this.cache.set(key, entry);
    this.lruOrder.push(key);

    return { entry, source: this.pages[entry.page].canvas };
  }

  /** Number of cached glyphs. */
  get size(): number {
    return this.cache.size;
  }

  /** Number of atlas pages. */
  get pageCount(): number {
    return this.pages.length;
  }

  // Cache hit tracking for metrics
  private _hits = 0;
  private _misses = 0;

  get hits(): number { return this._hits; }
  get misses(): number { return this._misses; }

  resetMetrics() {
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Look up or rasterize, with hit/miss tracking.
   */
  getTracked(
    char: string,
    bold: boolean,
    italic: boolean,
    faint: boolean,
    fgColor: string,
    wide: boolean,
  ): { entry: GlyphEntry; source: OffscreenCanvas | HTMLCanvasElement } {
    const key = this.makeKey(char, bold, italic, faint, fgColor, wide);
    const existing = this.cache.get(key);
    if (existing) {
      this._hits++;
      this.touchLru(key);
      return { entry: existing, source: this.pages[existing.page].canvas };
    }
    this._misses++;
    const entry = this.rasterize(char, bold, italic, faint, fgColor, wide);
    this.cache.set(key, entry);
    this.lruOrder.push(key);
    return { entry, source: this.pages[entry.page].canvas };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private makeKey(
    char: string,
    bold: boolean,
    italic: boolean,
    faint: boolean,
    fgColor: string,
    wide: boolean,
  ): string {
    // Compact key: char|flags|color
    const flags = (bold ? 1 : 0) | (italic ? 2 : 0) | (faint ? 4 : 0) | (wide ? 8 : 0);
    return `${char}|${flags}|${fgColor}`;
  }

  private rasterize(
    char: string,
    bold: boolean,
    italic: boolean,
    faint: boolean,
    fgColor: string,
    wide: boolean,
  ): GlyphEntry {
    const dpr = this.dpr;
    const w = Math.ceil((wide ? this.cellWidth * 2 : this.cellWidth) * dpr);
    const h = Math.ceil(this.cellHeight * dpr);

    // Find a page with space
    const pageIdx = this.findPageWithSpace(w, h);
    const page = this.pages[pageIdx];
    const { ctx } = page;

    const x = page.cursorX;
    const y = page.cursorY;

    // Rasterize at physical pixel resolution
    ctx.save();

    // Pick font
    const font = bold && italic ? this.boldItalicFont
      : bold ? this.boldFont
      : italic ? this.italicFont
      : this.baseFont;

    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = fgColor;
    if (faint) ctx.globalAlpha = 0.5;

    // Scale to physical pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillText(char, x / dpr, y / dpr + this.baseline);

    ctx.restore();
    // Restore the identity transform for future rasterizations at physical coords
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Advance cursor
    page.cursorX += w;
    if (h > page.rowHeight) page.rowHeight = h;

    return { page: pageIdx, x, y, w, h };
  }

  private findPageWithSpace(w: number, h: number): number {
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const page = this.pages[i];
      // Does it fit in the current row?
      if (page.cursorX + w <= PAGE_SIZE && page.cursorY + h <= PAGE_SIZE) {
        return i;
      }
      // Start a new row?
      if (page.cursorY + page.rowHeight + h <= PAGE_SIZE) {
        page.cursorY += page.rowHeight;
        page.cursorX = 0;
        page.rowHeight = 0;
        if (page.cursorX + w <= PAGE_SIZE) {
          return i;
        }
      }
    }

    // No space — check if we should evict or add a page
    if (this.pages.length >= 4) {
      // Evict the oldest page worth of entries and reuse it
      this.evictOldestPage();
      return this.pages.length - 1;
    }

    // Add a new page
    return this.addPage();
  }

  private addPage(): number {
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(PAGE_SIZE, PAGE_SIZE);
      ctx = canvas.getContext("2d")!;
    } else {
      canvas = document.createElement("canvas");
      canvas.width = PAGE_SIZE;
      canvas.height = PAGE_SIZE;
      ctx = canvas.getContext("2d")!;
    }

    this.pages.push({
      canvas,
      ctx,
      cursorX: 0,
      cursorY: 0,
      rowHeight: 0,
    });

    return this.pages.length - 1;
  }

  private evictOldestPage() {
    // Find the page with the most stale entries (page 0 if all are full)
    const targetPage = 0;

    // Remove all cache entries on this page
    const keysToRemove: string[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.page === targetPage) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      this.cache.delete(key);
    }
    this.lruOrder = this.lruOrder.filter((k) => !keysToRemove.includes(k));

    // Clear the page canvas
    const page = this.pages[targetPage];
    page.ctx.clearRect(0, 0, PAGE_SIZE, PAGE_SIZE);
    page.cursorX = 0;
    page.cursorY = 0;
    page.rowHeight = 0;

    // Move it to the end so it's used next
    this.pages.push(this.pages.splice(targetPage, 1)[0]);

    // Fix page indices for all remaining entries
    for (const [, entry] of this.cache) {
      if (entry.page > targetPage) entry.page--;
    }
  }

  private touchLru(key: string) {
    // Move to end (most recently used). Only if it's in the first half
    // to avoid O(n) on every hit — partial LRU is fine for eviction
    const idx = this.lruOrder.indexOf(key);
    if (idx >= 0 && idx < this.lruOrder.length / 2) {
      this.lruOrder.splice(idx, 1);
      this.lruOrder.push(key);
    }
  }
}
