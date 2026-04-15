// ---------------------------------------------------------------------------
// EditorHost — canvas-based code editor using Pretext.js + GlyphAtlas
// ---------------------------------------------------------------------------
// Mirrors the TerminalHost architecture: owns canvas, input, cursor blink,
// and delegates to GlyphAtlas for glyph rendering.

import { prepare, layout } from "@chenglou/pretext";
import { GlyphAtlas } from "../terminal/GlyphAtlas";
import { EditorBuffer, selectionOrdered } from "./EditorBuffer";
import { tokenizeLine, tokenColor } from "./Tokenizer";
import type { Theme } from "../terminal/types";
import { DEFAULT_THEME } from "../terminal/types";
import {
  READ_FILE_CMD, WRITE_FILE_CMD,
} from "../ipc/types";

const { invoke } = (window as any).__TAURI__.core;

export class EditorHost {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private atlas: GlyphAtlas;
  readonly buffer = new EditorBuffer();
  private theme: Theme;

  // Font metrics (measured via Pretext, same as Renderer.ts)
  private fontSize: number;
  private fontFamily: string;
  private baseFont: string;
  cellWidth = 0;
  cellHeight = 0;
  private baseline = 0;
  private dpr: number;

  // Viewport
  private scrollTop = 0; // first visible line index
  private visibleLines = 0;
  private visibleCols = 0;

  // Gutter
  private gutterCols = 0;
  private gutterWidth = 0;

  // Cursor blink
  private cursorOn = true;
  private blinkTimer: number | null = null;

  // Draw batching
  private drawQueued = false;

  // Mouse selection
  private selecting = false;

  // File info
  filePath: string | undefined;
  private fileExt = "";

  // Callbacks
  onTitleChange?: (title: string) => void;

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      fontSize?: number;
      fontFamily?: string;
      theme?: Partial<Theme>;
      filePath?: string;
    } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.dpr = window.devicePixelRatio || 1;
    this.fontSize = options.fontSize ?? 14;
    this.fontFamily = options.fontFamily ?? "Menlo, Monaco, 'Courier New', monospace";
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.baseFont = `${this.fontSize}px ${this.fontFamily}`;
    this.filePath = options.filePath;
    if (this.filePath) {
      this.fileExt = this.filePath.split(".").pop() ?? "";
    }

    this.measureCellMetrics();
    this.atlas = new GlyphAtlas(
      this.cellWidth, this.cellHeight, this.baseline, this.dpr,
      this.fontSize, this.fontFamily,
    );

    this.computeViewport();
    this.startBlink();

    // Input events
    canvas.addEventListener("keydown", this.handleKeyDown);
    canvas.addEventListener("mousedown", this.handleMouseDown);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("paste", this.handlePaste);

    this.scheduleDraw();
  }

  // ---------------------------------------------------------------------------
  // Metrics (same approach as Renderer.ts)
  // ---------------------------------------------------------------------------

  private measureCellMetrics() {
    const ref = "MMMMMMMMMM";
    const lineHeight = Math.ceil(this.fontSize * 1.2);
    const prepared = prepare(ref, this.baseFont, { whiteSpace: "pre-wrap" });
    layout(prepared, Infinity, lineHeight);

    this.ctx.font = this.baseFont;
    const metrics = this.ctx.measureText("M");

    const rawWidth = metrics.width;
    const rawHeight = lineHeight;
    const dpr = this.dpr;

    this.cellWidth = Math.round(rawWidth * dpr) / dpr;
    this.cellHeight = Math.round(rawHeight * dpr) / dpr;
    this.baseline = metrics.actualBoundingBoxAscent ?? this.fontSize * 0.8;
  }

  // ---------------------------------------------------------------------------
  // Viewport
  // ---------------------------------------------------------------------------

  private computeViewport() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    // Resize canvas
    const w = rect.width;
    const h = rect.height;
    this.canvas.width = Math.ceil(w * this.dpr);
    this.canvas.height = Math.ceil(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Gutter
    this.gutterCols = Math.max(3, Math.floor(Math.log10(Math.max(1, this.buffer.lineCount))) + 2);
    this.gutterWidth = this.gutterCols * this.cellWidth;

    this.visibleLines = Math.floor(h / this.cellHeight);
    this.visibleCols = Math.floor((w - this.gutterWidth) / this.cellWidth);
  }

  fit() {
    this.computeViewport();
    this.scheduleDraw();
  }

  // ---------------------------------------------------------------------------
  // File I/O
  // ---------------------------------------------------------------------------

  async loadFile(path: string) {
    const contents = (await invoke(READ_FILE_CMD, { path })) as string;
    this.buffer.setText(contents);
    this.filePath = path;
    this.fileExt = path.split(".").pop() ?? "";
    this.scrollTop = 0;
    this.computeViewport();
    this.onTitleChange?.(path.split("/").pop()!);
    this.scheduleDraw();
  }

  async saveFile() {
    if (!this.filePath) return;
    await invoke(WRITE_FILE_CMD, { path: this.filePath, contents: this.buffer.getText() });
    this.buffer.dirty = false;
    this.onTitleChange?.(this.filePath.split("/").pop()!);
    this.scheduleDraw();
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  private handleKeyDown = (e: KeyboardEvent) => {
    const shift = e.shiftKey;

    // Cmd shortcuts
    if (e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "s":
          e.preventDefault();
          this.saveFile();
          return;
        case "z":
          e.preventDefault();
          if (shift) this.buffer.redo();
          else this.buffer.undo();
          this.ensureCursorVisible();
          this.scheduleDraw();
          return;
        case "a":
          e.preventDefault();
          this.buffer.selectAll();
          this.scheduleDraw();
          return;
        case "c": {
          e.preventDefault();
          const text = this.buffer.getSelectedText();
          if (text) navigator.clipboard.writeText(text);
          return;
        }
        case "x": {
          e.preventDefault();
          const text = this.buffer.getSelectedText();
          if (text) {
            navigator.clipboard.writeText(text);
            this.buffer.deleteSelection();
            this.ensureCursorVisible();
            this.scheduleDraw();
          }
          return;
        }
      }
      return; // don't handle other Cmd combos
    }

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        this.buffer.moveLeft(shift);
        this.buffer.finalizeSelection();
        break;
      case "ArrowRight":
        e.preventDefault();
        this.buffer.moveRight(shift);
        this.buffer.finalizeSelection();
        break;
      case "ArrowUp":
        e.preventDefault();
        this.buffer.moveUp(shift);
        this.buffer.finalizeSelection();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.buffer.moveDown(shift);
        this.buffer.finalizeSelection();
        break;
      case "Home":
        e.preventDefault();
        this.buffer.moveToLineStart(shift);
        this.buffer.finalizeSelection();
        break;
      case "End":
        e.preventDefault();
        this.buffer.moveToLineEnd(shift);
        this.buffer.finalizeSelection();
        break;
      case "Backspace":
        e.preventDefault();
        this.buffer.deleteChar(false);
        break;
      case "Delete":
        e.preventDefault();
        this.buffer.deleteChar(true);
        break;
      case "Enter":
        e.preventDefault();
        this.buffer.insertText("\n");
        break;
      case "Tab":
        e.preventDefault();
        this.buffer.insertText("  ");
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          this.buffer.insertText(e.key);
        } else {
          return; // don't redraw for unhandled keys
        }
    }

    this.ensureCursorVisible();
    this.resetBlink();
    this.scheduleDraw();
  };

  private handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text) {
      this.buffer.insertText(text);
      this.ensureCursorVisible();
      this.resetBlink();
      this.scheduleDraw();
    }
  };

  // ---------------------------------------------------------------------------
  // Mouse
  // ---------------------------------------------------------------------------

  private handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    this.canvas.focus();

    const pos = this.mouseToPos(e);
    this.buffer.cursor = pos;
    this.buffer.selection = null;
    this.selecting = true;

    const onMove = (ev: MouseEvent) => {
      if (!this.selecting) return;
      const p = this.mouseToPos(ev);
      if (!this.buffer.selection) {
        this.buffer.selection = { anchor: { ...this.buffer.cursor }, head: p };
      } else {
        this.buffer.selection.head = p;
      }
      this.buffer.cursor = { ...p };
      this.scheduleDraw();
    };

    const onUp = () => {
      this.selecting = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    this.resetBlink();
    this.scheduleDraw();
  };

  private mouseToPos(e: MouseEvent): { line: number; col: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - this.gutterWidth;
    const y = e.clientY - rect.top;

    const line = Math.max(0, Math.min(
      this.buffer.lineCount - 1,
      Math.floor(y / this.cellHeight) + this.scrollTop,
    ));
    const col = Math.max(0, Math.min(
      this.buffer.lines[line].length,
      Math.round(x / this.cellWidth),
    ));

    return { line, col };
  }

  // ---------------------------------------------------------------------------
  // Scroll
  // ---------------------------------------------------------------------------

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const lines = e.deltaY > 0 ? 3 : -3;
    this.scrollTop = Math.max(0, Math.min(
      Math.max(0, this.buffer.lineCount - this.visibleLines),
      this.scrollTop + lines,
    ));
    this.scheduleDraw();
  };

  private ensureCursorVisible() {
    const { line } = this.buffer.cursor;
    if (line < this.scrollTop) {
      this.scrollTop = line;
    } else if (line >= this.scrollTop + this.visibleLines) {
      this.scrollTop = line - this.visibleLines + 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private scheduleDraw() {
    if (!this.drawQueued) {
      this.drawQueued = true;
      requestAnimationFrame(() => {
        this.drawQueued = false;
        this.draw();
      });
    }
  }

  private draw() {
    const ctx = this.ctx;
    const { cellWidth, cellHeight, baseline, gutterWidth } = this;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    // Update gutter width
    this.gutterCols = Math.max(3, Math.floor(Math.log10(Math.max(1, this.buffer.lineCount))) + 2);
    this.gutterWidth = this.gutterCols * cellWidth;

    // Clear
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, w, h);

    // Gutter background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, this.gutterWidth, h);

    // Selection highlight
    if (this.buffer.selection) {
      const { start, end } = selectionOrdered(this.buffer.selection);
      ctx.fillStyle = this.theme.selectionBg;
      ctx.globalAlpha = 0.4;

      for (let vr = 0; vr < this.visibleLines; vr++) {
        const lineIdx = this.scrollTop + vr;
        if (lineIdx < start.line || lineIdx > end.line) continue;

        const lineLen = this.buffer.lines[lineIdx]?.length ?? 0;
        const colStart = lineIdx === start.line ? start.col : 0;
        const colEnd = lineIdx === end.line ? end.col : lineLen;

        ctx.fillRect(
          this.gutterWidth + colStart * cellWidth,
          vr * cellHeight,
          (colEnd - colStart) * cellWidth,
          cellHeight,
        );
      }
      ctx.globalAlpha = 1.0;
    }

    // Draw lines
    for (let vr = 0; vr < this.visibleLines; vr++) {
      const lineIdx = this.scrollTop + vr;
      if (lineIdx >= this.buffer.lineCount) break;

      const y = vr * cellHeight;

      // Line number
      const lineNum = String(lineIdx + 1);
      const numX = (this.gutterCols - 1 - lineNum.length) * cellWidth;
      ctx.font = this.baseFont;
      ctx.fillStyle = "#555";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(lineNum, numX, y + baseline);

      // Code content
      const line = this.buffer.lines[lineIdx];
      if (line.length === 0) continue;

      const tokens = tokenizeLine(line, this.fileExt);
      for (const token of tokens) {
        const color = tokenColor(token.type);
        const text = line.slice(token.start, token.start + token.length);

        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === " " || ch === "\t") continue;

          const col = token.start + i;
          const x = this.gutterWidth + col * cellWidth;
          const { entry, source } = this.atlas.get(ch, false, false, false, color, false);

          ctx.drawImage(
            source,
            entry.x, entry.y, entry.w, entry.h,
            x, y, entry.w / this.dpr, entry.h / this.dpr,
          );
        }
      }
    }

    // Cursor
    if (this.cursorOn) {
      const { line, col } = this.buffer.cursor;
      const vr = line - this.scrollTop;
      if (vr >= 0 && vr < this.visibleLines) {
        ctx.fillStyle = this.theme.cursor;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(
          this.gutterWidth + col * cellWidth,
          vr * cellHeight,
          2,
          cellHeight,
        );
        ctx.globalAlpha = 1.0;
      }
    }

    // Dirty indicator in gutter
    if (this.buffer.dirty) {
      ctx.fillStyle = "#e8ab53";
      ctx.beginPath();
      ctx.arc(this.gutterWidth - 6, 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------------------
  // Cursor blink
  // ---------------------------------------------------------------------------

  private startBlink() {
    this.blinkTimer = window.setInterval(() => {
      this.cursorOn = !this.cursorOn;
      this.scheduleDraw();
    }, 530);
  }

  private resetBlink() {
    this.cursorOn = true;
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
    this.startBlink();
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  focus() {
    this.canvas.focus();
  }

  dispose() {
    this.canvas.removeEventListener("keydown", this.handleKeyDown);
    this.canvas.removeEventListener("mousedown", this.handleMouseDown);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("paste", this.handlePaste);
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
  }
}
