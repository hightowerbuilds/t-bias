// ---------------------------------------------------------------------------
// Selection — pure coordinate state, no screen dependency
// ---------------------------------------------------------------------------

export interface SelectionRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export class Selection {
  private anchor: { col: number; row: number } | null = null;
  private head: { col: number; row: number } | null = null;
  private _active = false;

  get active(): boolean {
    return this._active && this.anchor !== null && this.head !== null;
  }

  /** Get the normalized (start <= end) selection range. */
  get range(): SelectionRange | null {
    if (!this.active || !this.anchor || !this.head) return null;

    let { col: sc, row: sr } = this.anchor;
    let { col: ec, row: er } = this.head;

    // Normalize: start should be before end
    if (sr > er || (sr === er && sc > ec)) {
      [sc, sr, ec, er] = [ec, er, sc, sr];
    }

    return { startCol: sc, startRow: sr, endCol: ec, endRow: er };
  }

  start(col: number, row: number) {
    this.anchor = { col, row };
    this.head = { col, row };
    this._active = true;
  }

  update(col: number, row: number) {
    if (!this._active) return;
    this.head = { col, row };
  }

  finish() {
    // Keep selection visible but stop tracking
  }

  clear() {
    this.anchor = null;
    this.head = null;
    this._active = false;
  }

  /** Check if a cell is within the selection. */
  contains(col: number, row: number): boolean {
    const r = this.range;
    if (!r) return false;

    if (row < r.startRow || row > r.endRow) return false;
    if (row === r.startRow && row === r.endRow) {
      return col >= r.startCol && col <= r.endCol;
    }
    if (row === r.startRow) return col >= r.startCol;
    if (row === r.endRow) return col <= r.endCol;
    return true;
  }
}
