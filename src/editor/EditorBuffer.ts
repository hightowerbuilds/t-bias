// ---------------------------------------------------------------------------
// EditorBuffer — pure text buffer with cursor, selection, and undo/redo
// ---------------------------------------------------------------------------

export interface CursorPos {
  line: number; // 0-based
  col: number;  // 0-based, in characters
}

export interface EditorSelection {
  anchor: CursorPos;
  head: CursorPos;
}

interface EditCommand {
  type: "insert" | "delete";
  pos: CursorPos;
  text: string;
  cursorBefore: CursorPos;
  cursorAfter: CursorPos;
}

function posEq(a: CursorPos, b: CursorPos): boolean {
  return a.line === b.line && a.col === b.col;
}

function posBefore(a: CursorPos, b: CursorPos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

export function selectionOrdered(sel: EditorSelection): { start: CursorPos; end: CursorPos } {
  if (posBefore(sel.anchor, sel.head)) {
    return { start: sel.anchor, end: sel.head };
  }
  return { start: sel.head, end: sel.anchor };
}

export class EditorBuffer {
  lines: string[] = [""];
  cursor: CursorPos = { line: 0, col: 0 };
  selection: EditorSelection | null = null;
  dirty = false;

  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];

  get lineCount(): number {
    return this.lines.length;
  }

  // ---------------------------------------------------------------------------
  // Load / Export
  // ---------------------------------------------------------------------------

  setText(text: string) {
    this.lines = text.split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.cursor = { line: 0, col: 0 };
    this.selection = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
  }

  getText(): string {
    return this.lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Text modification
  // ---------------------------------------------------------------------------

  insertText(text: string) {
    if (this.selection) this.deleteSelection();

    const before = { ...this.cursor };
    this.rawInsert(this.cursor, text);
    const after = { ...this.cursor };

    this.undoStack.push({ type: "insert", pos: before, text, cursorBefore: before, cursorAfter: after });
    this.redoStack.length = 0;
    this.dirty = true;
  }

  deleteChar(forward: boolean) {
    if (this.selection) {
      this.deleteSelection();
      return;
    }

    const before = { ...this.cursor };
    let deleted: string;

    if (forward) {
      const line = this.lines[this.cursor.line];
      if (this.cursor.col < line.length) {
        deleted = line[this.cursor.col];
        this.lines[this.cursor.line] = line.slice(0, this.cursor.col) + line.slice(this.cursor.col + 1);
      } else if (this.cursor.line < this.lines.length - 1) {
        deleted = "\n";
        this.lines[this.cursor.line] = line + this.lines[this.cursor.line + 1];
        this.lines.splice(this.cursor.line + 1, 1);
      } else {
        return;
      }
    } else {
      if (this.cursor.col > 0) {
        const line = this.lines[this.cursor.line];
        deleted = line[this.cursor.col - 1];
        this.lines[this.cursor.line] = line.slice(0, this.cursor.col - 1) + line.slice(this.cursor.col);
        this.cursor.col--;
      } else if (this.cursor.line > 0) {
        deleted = "\n";
        const prevLine = this.lines[this.cursor.line - 1];
        this.cursor.col = prevLine.length;
        this.lines[this.cursor.line - 1] = prevLine + this.lines[this.cursor.line];
        this.lines.splice(this.cursor.line, 1);
        this.cursor.line--;
      } else {
        return;
      }
    }

    const delPos = forward ? before : { ...this.cursor };
    this.undoStack.push({ type: "delete", pos: delPos, text: deleted, cursorBefore: before, cursorAfter: { ...this.cursor } });
    this.redoStack.length = 0;
    this.dirty = true;
  }

  deleteSelection() {
    if (!this.selection) return;
    const { start, end } = selectionOrdered(this.selection);
    const before = { ...this.cursor };

    const deleted = this.getTextRange(start, end);
    this.rawDelete(start, end);
    this.cursor = { ...start };
    this.selection = null;

    this.undoStack.push({ type: "delete", pos: start, text: deleted, cursorBefore: before, cursorAfter: { ...this.cursor } });
    this.redoStack.length = 0;
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Cursor movement
  // ---------------------------------------------------------------------------

  moveLeft(selecting = false) {
    this.updateSelection(selecting);
    if (this.cursor.col > 0) {
      this.cursor.col--;
    } else if (this.cursor.line > 0) {
      this.cursor.line--;
      this.cursor.col = this.lines[this.cursor.line].length;
    }
  }

  moveRight(selecting = false) {
    this.updateSelection(selecting);
    const line = this.lines[this.cursor.line];
    if (this.cursor.col < line.length) {
      this.cursor.col++;
    } else if (this.cursor.line < this.lines.length - 1) {
      this.cursor.line++;
      this.cursor.col = 0;
    }
  }

  moveUp(selecting = false) {
    this.updateSelection(selecting);
    if (this.cursor.line > 0) {
      this.cursor.line--;
      this.cursor.col = Math.min(this.cursor.col, this.lines[this.cursor.line].length);
    }
  }

  moveDown(selecting = false) {
    this.updateSelection(selecting);
    if (this.cursor.line < this.lines.length - 1) {
      this.cursor.line++;
      this.cursor.col = Math.min(this.cursor.col, this.lines[this.cursor.line].length);
    }
  }

  moveToLineStart(selecting = false) {
    this.updateSelection(selecting);
    this.cursor.col = 0;
  }

  moveToLineEnd(selecting = false) {
    this.updateSelection(selecting);
    this.cursor.col = this.lines[this.cursor.line].length;
  }

  moveToTop(selecting = false) {
    this.updateSelection(selecting);
    this.cursor.line = 0;
    this.cursor.col = 0;
  }

  moveToBottom(selecting = false) {
    this.updateSelection(selecting);
    this.cursor.line = this.lines.length - 1;
    this.cursor.col = this.lines[this.cursor.line].length;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  private updateSelection(selecting: boolean) {
    if (selecting) {
      if (!this.selection) {
        this.selection = { anchor: { ...this.cursor }, head: { ...this.cursor } };
      }
    } else {
      this.selection = null;
    }
  }

  /** Must be called after cursor movement when selecting. */
  finalizeSelection() {
    if (this.selection) {
      this.selection.head = { ...this.cursor };
      if (posEq(this.selection.anchor, this.selection.head)) {
        this.selection = null;
      }
    }
  }

  selectAll() {
    this.selection = {
      anchor: { line: 0, col: 0 },
      head: { line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length },
    };
    this.cursor = { ...this.selection.head };
  }

  getSelectedText(): string | null {
    if (!this.selection) return null;
    const { start, end } = selectionOrdered(this.selection);
    return this.getTextRange(start, end);
  }

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;

    if (cmd.type === "insert") {
      const end = this.posAfterInsert(cmd.pos, cmd.text);
      this.rawDelete(cmd.pos, end);
    } else {
      this.rawInsertAt(cmd.pos, cmd.text);
    }

    this.cursor = { ...cmd.cursorBefore };
    this.selection = null;
    this.redoStack.push(cmd);
    this.dirty = true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;

    if (cmd.type === "insert") {
      this.rawInsertAt(cmd.pos, cmd.text);
    } else {
      const end = this.posAfterInsert(cmd.pos, cmd.text);
      this.rawDelete(cmd.pos, end);
    }

    this.cursor = { ...cmd.cursorAfter };
    this.selection = null;
    this.undoStack.push(cmd);
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private rawInsert(at: CursorPos, text: string) {
    const parts = text.split("\n");
    const line = this.lines[at.line];
    const before = line.slice(0, at.col);
    const after = line.slice(at.col);

    if (parts.length === 1) {
      this.lines[at.line] = before + parts[0] + after;
      this.cursor = { line: at.line, col: at.col + parts[0].length };
    } else {
      this.lines[at.line] = before + parts[0];
      const newLines = parts.slice(1, -1);
      const lastPart = parts[parts.length - 1];
      this.lines.splice(at.line + 1, 0, ...newLines, lastPart + after);
      this.cursor = { line: at.line + parts.length - 1, col: lastPart.length };
    }
  }

  /** Insert without moving the buffer cursor (used by undo/redo). */
  private rawInsertAt(at: CursorPos, text: string) {
    const parts = text.split("\n");
    const line = this.lines[at.line];
    const before = line.slice(0, at.col);
    const after = line.slice(at.col);

    if (parts.length === 1) {
      this.lines[at.line] = before + parts[0] + after;
    } else {
      this.lines[at.line] = before + parts[0];
      const lastPart = parts[parts.length - 1];
      this.lines.splice(at.line + 1, 0, ...parts.slice(1, -1), lastPart + after);
    }
  }

  private rawDelete(from: CursorPos, to: CursorPos) {
    if (from.line === to.line) {
      const line = this.lines[from.line];
      this.lines[from.line] = line.slice(0, from.col) + line.slice(to.col);
    } else {
      const startLine = this.lines[from.line].slice(0, from.col);
      const endLine = this.lines[to.line].slice(to.col);
      this.lines.splice(from.line, to.line - from.line + 1, startLine + endLine);
    }
  }

  private getTextRange(from: CursorPos, to: CursorPos): string {
    if (from.line === to.line) {
      return this.lines[from.line].slice(from.col, to.col);
    }
    const parts: string[] = [];
    parts.push(this.lines[from.line].slice(from.col));
    for (let i = from.line + 1; i < to.line; i++) {
      parts.push(this.lines[i]);
    }
    parts.push(this.lines[to.line].slice(0, to.col));
    return parts.join("\n");
  }

  private posAfterInsert(at: CursorPos, text: string): CursorPos {
    const parts = text.split("\n");
    if (parts.length === 1) {
      return { line: at.line, col: at.col + text.length };
    }
    return { line: at.line + parts.length - 1, col: parts[parts.length - 1].length };
  }
}
