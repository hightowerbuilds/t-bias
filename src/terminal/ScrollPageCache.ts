// ---------------------------------------------------------------------------
// ScrollPageCache — pre-rendered canvas pages for fast scrollback rendering
// ---------------------------------------------------------------------------
// Lazily renders scrollback rows onto offscreen canvas pages when the user
// scrolls up. Once rendered, pages are cached and composited with drawImage()
// during scroll — O(1) per page vs O(rows*cols) per-cell rendering.
//
// Architecture:
//   - Each page holds ROWS_PER_PAGE rows of rendered terminal output
//   - Pages are created lazily when scrollback rows are first viewed
//   - On font/theme/DPR/resize change, the cache is invalidated
//   - The cache tracks which scrollback rows have been rendered

import type { RowSource } from "./IRenderer";
import type { CanvasRenderer } from "./Renderer";

const ROWS_PER_PAGE = 50;

interface ScrollPage {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** Scrollback row index of the first row on this page. */
  startRow: number;
  /** Number of rows rendered on this page (0..ROWS_PER_PAGE). */
  rowCount: number;
}

export class ScrollPageCache {
  private pages = new Map<number, ScrollPage>();  // keyed by page index
  private cellWidth = 0;
  private cellHeight = 0;
  private cols = 0;
  private dpr = 1;

  /** Update cell metrics when font/DPR/resize changes. Invalidates all pages. */
  updateMetrics(cellWidth: number, cellHeight: number, cols: number, dpr: number) {
    if (cellWidth === this.cellWidth && cellHeight === this.cellHeight &&
        cols === this.cols && dpr === this.dpr) return;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.cols = cols;
    this.dpr = dpr;
    this.invalidate();
  }

  /** Discard all cached pages. */
  invalidate() {
    this.pages.clear();
  }

  /** Ensure a scrollback row is rendered and cached. Returns true if the row
   *  is available in the cache for compositing. */
  ensureRow(
    scrollRow: number,
    getRowSource: (scrollRow: number) => RowSource,
    cols: number,
    renderer: CanvasRenderer,
  ): boolean {
    const pageIdx = Math.floor(scrollRow / ROWS_PER_PAGE);
    let page = this.pages.get(pageIdx);

    if (!page) {
      page = this.createPage(pageIdx * ROWS_PER_PAGE);
      this.pages.set(pageIdx, page);
    }

    const rowInPage = scrollRow - page.startRow;
    if (rowInPage < page.rowCount) return true; // Already rendered

    // Render all rows up to this one on this page
    for (let r = page.rowCount; r <= rowInPage; r++) {
      const src = getRowSource(page.startRow + r);
      const y = r * this.cellHeight;
      renderer.drawRowToContext(
        page.ctx, src, 0, cols, y, this.cellWidth, this.cellHeight,
      );
      page.rowCount = r + 1;
    }

    return true;
  }

  /** Composite a range of cached scrollback rows onto the main canvas.
   *  `startRow` is the first scrollback row visible at the top of the viewport.
   *  `count` is how many scrollback rows to composite.
   *  `dstY` is the Y offset on the destination canvas to start drawing. */
  compositeRows(
    ctx: CanvasRenderingContext2D,
    startRow: number,
    count: number,
    dstY: number = 0,
  ): void {
    const { cellWidth, cellHeight, cols, dpr } = this;
    const rowWidthPx = cols * cellWidth;

    for (let i = 0; i < count; i++) {
      const scrollRow = startRow + i;
      const pageIdx = Math.floor(scrollRow / ROWS_PER_PAGE);
      const page = this.pages.get(pageIdx);
      if (!page) continue;

      const rowInPage = scrollRow - page.startRow;
      if (rowInPage >= page.rowCount) continue;

      const srcY = rowInPage * cellHeight;

      ctx.drawImage(
        page.canvas,
        0, srcY * dpr,
        rowWidthPx * dpr, cellHeight * dpr,
        0, dstY + i * cellHeight,
        rowWidthPx, cellHeight,
      );
    }
  }

  private createPage(startRow: number): ScrollPage {
    const w = Math.ceil(this.cols * this.cellWidth * this.dpr);
    const h = Math.ceil(ROWS_PER_PAGE * this.cellHeight * this.dpr);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return { canvas, ctx, startRow, rowCount: 0 };
  }
}
