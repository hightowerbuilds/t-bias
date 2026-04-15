import { TerminalCore } from "./TerminalCore";
import { Selection } from "./Selection";
import { keyboardEventToSequence } from "./input";
import type { IRenderer, SelectionBounds } from "./IRenderer";
import type { TerminalOptions, Theme } from "./types";
import { DEFAULT_THEME } from "./types";
import { CanvasRenderer } from "./Renderer";

// ---------------------------------------------------------------------------
// TerminalHost — DOM-aware orchestrator
// ---------------------------------------------------------------------------
// Owns canvases, event listeners, cursor blink, and selection.
// Delegates terminal logic to TerminalCore, text rendering to IRenderer,
// and manages cursor + selection layers directly.

export class TerminalHost {
  readonly core: TerminalCore;
  private renderer: IRenderer;

  // Canvas layers
  private textCanvas: HTMLCanvasElement;           // Layer 0: text + backgrounds
  private selectionCanvas: HTMLCanvasElement | null = null; // Layer 1: selection overlay
  private cursorCanvas: HTMLCanvasElement | null = null;    // Layer 2: cursor

  private selCtx: CanvasRenderingContext2D | null = null;
  private curCtx: CanvasRenderingContext2D | null = null;

  private cols: number;
  private rows: number;
  private theme: Theme;
  private dpr: number;

  // Font size
  private fontSize: number;
  private readonly defaultFontSize: number;
  private static readonly MIN_FONT_SIZE = 8;
  private static readonly MAX_FONT_SIZE = 32;

  // Padding (CSS pixels around the terminal grid)
  private padding: number;

  // Cursor config
  private cursorStyle: "block" | "underline" | "bar";
  private cursorBlink: boolean;

  // Cursor blink
  private cursorOn = true;
  private blinkTimer: number | null = null;

  // Write buffer — coalesces rapid pty-output events into single parser passes
  private writeBuf: string[] = [];
  private writeBufBytes = 0;

  // Render batching + throughput detection
  private textDrawQueued = false;
  private overlayDrawQueued = false;
  private writesSinceLastFrame = 0;
  private bytesSinceLastFrame = 0;
  private static readonly HIGH_THROUGHPUT_BYTES = 65536; // 64KB threshold

  // Mouse state
  private mouseDown = false;
  private mouseButton = -1;

  // Selection
  private selection = new Selection();
  private selecting = false;

  // Debug overlay
  private debugOverlay = false;
  private debugEl: HTMLDivElement | null = null;

  // Latency + throughput measurement
  private lastKeypressTime = 0;    // timestamp of most recent keypress
  private lastInputLatency = 0;    // ms from keypress to next draw completion
  private throughputWindow: number[] = []; // bytes received per second (ring buffer)
  private throughputAccum = 0;      // bytes received in current second
  private throughputTimer: number | null = null;

  // Callbacks
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;

  constructor(textCanvas: HTMLCanvasElement, options: TerminalOptions = {}) {
    this.textCanvas = textCanvas;
    const fontSize = options.fontSize ?? 14;
    const fontFamily =
      options.fontFamily ?? "Menlo, Monaco, 'Courier New', monospace";
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.dpr = window.devicePixelRatio || 1;
    this.padding = options.padding ?? 0;
    this.cursorStyle = options.cursorStyle ?? "block";
    this.cursorBlink = options.cursorBlink ?? true;

    this.fontSize = fontSize;
    this.defaultFontSize = fontSize;
    this.renderer = new CanvasRenderer(textCanvas, { fontSize, fontFamily, theme: this.theme });

    // Apply padding to the canvas container
    if (this.padding > 0) {
      const container = textCanvas.parentElement;
      if (container) {
        container.style.padding = `${this.padding}px`;
        container.style.boxSizing = "border-box";
      }
    }

    const rect = textCanvas.parentElement?.getBoundingClientRect() ?? {
      width: 960,
      height: 640,
    };
    const availWidth = rect.width - this.padding * 2;
    const availHeight = rect.height - this.padding * 2;
    const grid = this.renderer.gridSize(availWidth, availHeight);
    this.cols = grid.cols;
    this.rows = grid.rows;

    this.core = new TerminalCore(this.cols, this.rows, options.scrollbackLimit ?? 5000);
    this.core.cursorShape = this.cursorStyle;
    this.core.onResponse = (data) => this.onData?.(data);
    this.core.onTitleChange = (title) => this.onTitleChange?.(title);

    this.renderer.resize(this.cols, this.rows);

    // Re-fit when DPR changes (window moved to different display)
    if (this.renderer instanceof CanvasRenderer) {
      (this.renderer as CanvasRenderer).onDprChange = () => {
        this.dpr = window.devicePixelRatio || 1;
        this.fit();
      };
    }

    // Create overlay canvases (selection + cursor)
    this.createOverlayCanvases();

    // Input events on the top-most canvas (or text canvas if overlays not created)
    const inputTarget = this.cursorCanvas ?? this.textCanvas;
    inputTarget.addEventListener("keydown", this.handleKeyDown);
    inputTarget.addEventListener("paste", this.handlePaste);
    inputTarget.addEventListener("mousedown", this.handleMouseDown);
    inputTarget.addEventListener("mouseup", this.handleMouseUp);
    inputTarget.addEventListener("mousemove", this.handleMouseMove);
    inputTarget.addEventListener("wheel", this.handleWheel, { passive: false });
    inputTarget.addEventListener("contextmenu", this.handleContextMenu);
    inputTarget.addEventListener("focus", this.handleFocus);
    inputTarget.addEventListener("blur", this.handleBlur);

    if (this.cursorBlink) {
      this.startBlink();
    }
    this.startThroughputTimer();
    this.scheduleTextDraw();
    this.scheduleOverlayDraw();
  }

  /** Attach overlay canvases for selection and cursor. */
  private createOverlayCanvases() {
    const container = this.textCanvas.parentElement;
    if (!container) return;

    // Selection canvas (Layer 1)
    this.selectionCanvas = document.createElement("canvas");
    this.selectionCanvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";
    container.appendChild(this.selectionCanvas);
    this.selCtx = this.selectionCanvas.getContext("2d", { alpha: true })!;

    // Cursor canvas (Layer 2) — receives input events
    this.cursorCanvas = document.createElement("canvas");
    this.cursorCanvas.tabIndex = 0;
    this.cursorCanvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;outline:none;";
    container.appendChild(this.cursorCanvas);
    this.curCtx = this.cursorCanvas.getContext("2d", { alpha: true })!;

    this.resizeOverlayCanvases();
  }

  private resizeOverlayCanvases() {
    const w = this.cols * this.renderer.cellWidth;
    const h = this.rows * this.renderer.cellHeight;

    for (const c of [this.selectionCanvas, this.cursorCanvas]) {
      if (!c) continue;
      c.width = Math.ceil(w * this.dpr);
      c.height = Math.ceil(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    if (this.selCtx) this.selCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.curCtx) this.curCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  get gridSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  get cellWidth(): number {
    return this.renderer.cellWidth;
  }

  get cellHeight(): number {
    return this.renderer.cellHeight;
  }

  write(data: string) {
    // Buffer the data — it will be flushed to the parser before the next render.
    // This coalesces multiple rapid pty-output events into a single parser pass,
    // reducing per-call overhead and enabling the parser to process larger chunks.
    this.writeBuf.push(data);
    this.writeBufBytes += data.length;
    this.writesSinceLastFrame++;
    this.bytesSinceLastFrame += data.length;
    this.throughputAccum += data.length;
    this.scheduleTextDraw();
    this.scheduleOverlayDraw();
  }

  /** Flush buffered writes to the parser in one pass. */
  private flushWriteBuffer() {
    if (this.writeBuf.length === 0) return;

    if (this.writeBuf.length === 1) {
      // Single write — no concatenation needed
      this.core.write(this.writeBuf[0]);
    } else {
      // Multiple writes — concatenate and feed once
      this.core.write(this.writeBuf.join(""));
    }

    this.writeBuf.length = 0;
    this.writeBufBytes = 0;
  }

  fit(): { cols: number; rows: number } {
    const rect = this.textCanvas.parentElement?.getBoundingClientRect();
    if (!rect) return { cols: this.cols, rows: this.rows };

    const availWidth = rect.width - this.padding * 2;
    const availHeight = rect.height - this.padding * 2;
    const grid = this.renderer.gridSize(availWidth, availHeight);
    if (grid.cols !== this.cols || grid.rows !== this.rows) {
      this.cols = grid.cols;
      this.rows = grid.rows;
      this.core.resize(this.cols, this.rows);
      this.renderer.resize(this.cols, this.rows);
      this.resizeOverlayCanvases();
      this.scheduleTextDraw();
      this.scheduleOverlayDraw();
      this.onResize?.(this.cols, this.rows);
    }

    return { cols: this.cols, rows: this.rows };
  }

  focus() {
    (this.cursorCanvas ?? this.textCanvas).focus();
  }

  zoom(delta: number) {
    this.setFontSize(this.fontSize + delta);
  }

  setFontSize(size: number) {
    const clamped = Math.max(TerminalHost.MIN_FONT_SIZE, Math.min(TerminalHost.MAX_FONT_SIZE, size));
    if (clamped === this.fontSize) return;
    this.fontSize = clamped;
    this.renderer.setFontSize(clamped);
    this.fit();
  }

  dispose() {
    const inputTarget = this.cursorCanvas ?? this.textCanvas;
    inputTarget.removeEventListener("keydown", this.handleKeyDown);
    inputTarget.removeEventListener("paste", this.handlePaste);
    inputTarget.removeEventListener("mousedown", this.handleMouseDown);
    inputTarget.removeEventListener("mouseup", this.handleMouseUp);
    inputTarget.removeEventListener("mousemove", this.handleMouseMove);
    inputTarget.removeEventListener("wheel", this.handleWheel);
    inputTarget.removeEventListener("contextmenu", this.handleContextMenu);
    inputTarget.removeEventListener("focus", this.handleFocus);
    inputTarget.removeEventListener("blur", this.handleBlur);
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
    if (this.throughputTimer !== null) clearInterval(this.throughputTimer);
    this.renderer.dispose();
    this.selectionCanvas?.remove();
    this.cursorCanvas?.remove();
  }

  // =========================================================================
  // Keyboard
  // =========================================================================
  private handleKeyDown = (e: KeyboardEvent) => {
    const modes = this.core.modes;

    if (e.metaKey && e.key === "c") {
      if (this.selection.active) {
        const text = this.core.getSelectedText(this.selection);
        navigator.clipboard.writeText(text);
        this.selection.clear();
        this.scheduleOverlayDraw();
        e.preventDefault();
        return;
      }
      return;
    }

    if (e.metaKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      this.zoom(2);
      return;
    }
    if (e.metaKey && e.key === "-") {
      e.preventDefault();
      this.zoom(-2);
      return;
    }
    if (e.metaKey && e.key === "0") {
      e.preventDefault();
      this.setFontSize(this.defaultFontSize);
      return;
    }
    // Cmd+Shift+D: toggle debug overlay
    if (e.metaKey && e.shiftKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      this.toggleDebugOverlay();
      return;
    }
    // Cmd+Shift+S: dump screen state to console
    if (e.metaKey && e.shiftKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      this.dumpScreenState();
      return;
    }

    if (e.metaKey) return;

    if (e.shiftKey && !modes.isAlternateScreen) {
      if (e.key === "PageUp") {
        e.preventDefault();
        this.core.scrollViewport(this.rows);
        this.scheduleTextDraw();
        this.scheduleOverlayDraw();
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        this.core.scrollViewport(-this.rows);
        this.scheduleTextDraw();
        this.scheduleOverlayDraw();
        return;
      }
    }

    const seq = keyboardEventToSequence(e, modes.applicationCursor);
    if (seq !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (this.selection.active) {
        this.selection.clear();
        this.scheduleOverlayDraw();
      }
      this.core.resetViewport();
      this.lastKeypressTime = performance.now();
      this.onData?.(seq);
      this.resetBlink();
    }
  };

  private handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (!text) return;
    if (this.core.modes.bracketedPaste) {
      this.onData?.("\x1b[200~" + text + "\x1b[201~");
    } else {
      this.onData?.(text);
    }
  };

  // =========================================================================
  // Mouse
  // =========================================================================
  private mouseCol(e: MouseEvent): number {
    const rect = this.textCanvas.getBoundingClientRect();
    return Math.min(this.cols - 1, Math.max(0, Math.floor((e.clientX - rect.left) / this.renderer.cellWidth)));
  }

  private mouseRow(e: MouseEvent): number {
    const rect = this.textCanvas.getBoundingClientRect();
    return Math.min(this.rows - 1, Math.max(0, Math.floor((e.clientY - rect.top) / this.renderer.cellHeight)));
  }

  private encodeMouse(button: number, col: number, row: number, press: boolean) {
    const modes = this.core.modes;
    if (modes.mouseSgr) {
      const final = press ? "M" : "m";
      this.onData?.(`\x1b[<${button};${col + 1};${row + 1}${final}`);
    } else {
      if (press) {
        this.onData?.(
          `\x1b[M${String.fromCharCode(button + 32)}${String.fromCharCode(col + 33)}${String.fromCharCode(row + 33)}`
        );
      }
    }
  }

  private handleMouseDown = (e: MouseEvent) => {
    this.focus();
    const col = this.mouseCol(e);
    const row = this.mouseRow(e);
    const modes = this.core.modes;

    if (modes.mouseEnabled && e.button === 0 && !e.shiftKey) {
      e.preventDefault();
      let button = e.button;
      if (e.metaKey) button |= 8;
      if (e.ctrlKey) button |= 16;

      this.mouseDown = true;
      this.mouseButton = button;
      this.selection.clear();
      this.scheduleOverlayDraw();
      this.encodeMouse(button, col, row, true);
    } else if (e.button === 0) {
      e.preventDefault();
      this.selecting = true;
      this.selection.start(col, row);
      this.scheduleOverlayDraw();
    }
  };

  private handleMouseUp = (e: MouseEvent) => {
    const col = this.mouseCol(e);
    const row = this.mouseRow(e);
    const modes = this.core.modes;

    if (this.mouseDown && modes.mouseEnabled) {
      e.preventDefault();
      if (modes.mouseSgr) {
        this.encodeMouse(this.mouseButton, col, row, false);
      } else {
        this.encodeMouse(3, col, row, true);
      }
      this.mouseDown = false;
      this.mouseButton = -1;
    }

    if (this.selecting) {
      this.selecting = false;
      this.selection.finish();
    }
  };

  private handleMouseMove = (e: MouseEvent) => {
    const col = this.mouseCol(e);
    const row = this.mouseRow(e);
    const modes = this.core.modes;

    if (this.selecting) {
      this.selection.update(col, row);
      this.scheduleOverlayDraw();
      return;
    }

    if (!modes.mouseEnabled) return;
    if (!modes.mouseAll && !(modes.mouseDrag && this.mouseDown)) return;

    const button = this.mouseDown ? this.mouseButton + 32 : 35;
    this.encodeMouse(button, col, row, true);
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const modes = this.core.modes;

    if (modes.mouseEnabled) {
      const col = this.mouseCol(e);
      const row = this.mouseRow(e);
      const button = e.deltaY < 0 ? 64 : 65;
      this.encodeMouse(button, col, row, true);
    } else if (!modes.isAlternateScreen) {
      const lines = e.deltaY > 0 ? 3 : -3;
      this.core.scrollViewport(-lines);
      this.scheduleTextDraw();
      this.scheduleOverlayDraw();
    }
  };

  private handleContextMenu = (e: Event) => {
    if (this.core.modes.mouseEnabled) e.preventDefault();
  };

  private handleFocus = () => {
    if (this.core.modes.focusEvents) {
      this.onData?.("\x1b[I"); // Focus in
    }
  };

  private handleBlur = () => {
    if (this.core.modes.focusEvents) {
      this.onData?.("\x1b[O"); // Focus out
    }
  };

  // =========================================================================
  // Render — Text Layer (via IRenderer)
  // =========================================================================
  private scheduleTextDraw() {
    if (!this.textDrawQueued) {
      this.textDrawQueued = true;
      requestAnimationFrame(() => {
        this.textDrawQueued = false;
        // Flush all buffered writes in one parser pass, then render.
        this.flushWriteBuffer();
        this.writesSinceLastFrame = 0;
        this.bytesSinceLastFrame = 0;
        const state = this.core.getRenderState();
        this.renderer.draw(state);
        this.core.virtualCanvas.clearDirty();
        // Measure input latency: time from last keypress to draw completion
        if (this.lastKeypressTime > 0) {
          this.lastInputLatency = performance.now() - this.lastKeypressTime;
          this.lastKeypressTime = 0;
        }
        this.updateDebugOverlay();
      });
    }
  }

  // =========================================================================
  // Render — Overlay Layers (cursor + selection, drawn directly by host)
  // =========================================================================
  private scheduleOverlayDraw() {
    if (!this.overlayDrawQueued) {
      this.overlayDrawQueued = true;
      requestAnimationFrame(() => {
        this.overlayDrawQueued = false;
        this.drawSelectionLayer();
        this.drawCursorLayer();
      });
    }
  }

  private drawSelectionLayer() {
    const ctx = this.selCtx;
    if (!ctx) return;
    const { cellWidth, cellHeight } = this.renderer;
    const w = this.cols * cellWidth;
    const h = this.rows * cellHeight;

    ctx.clearRect(0, 0, w, h);

    const sel = this.selection.range;
    if (!sel || !this.selection.active) return;

    ctx.fillStyle = this.theme.selectionBg;
    ctx.globalAlpha = 0.4;

    for (let row = sel.startRow; row <= sel.endRow && row < this.rows; row++) {
      if (row < 0) continue;
      const colStart = row === sel.startRow ? sel.startCol : 0;
      const colEnd = row === sel.endRow ? sel.endCol : this.cols - 1;
      ctx.fillRect(
        colStart * cellWidth,
        row * cellHeight,
        (colEnd - colStart + 1) * cellWidth,
        cellHeight,
      );
    }

    ctx.globalAlpha = 1.0;
  }

  private drawCursorLayer() {
    const ctx = this.curCtx;
    if (!ctx) return;
    const { cellWidth, cellHeight } = this.renderer;
    const w = this.cols * cellWidth;
    const h = this.rows * cellHeight;

    ctx.clearRect(0, 0, w, h);

    const cursor = this.core.cursor;
    if (!cursor.visible || !this.cursorOn || this.core.viewportOffset > 0) return;

    const x = cursor.x * cellWidth;
    const y = cursor.y * cellHeight;
    ctx.fillStyle = this.theme.cursor;

    switch (cursor.shape) {
      case "block":
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x, y, cellWidth, cellHeight);
        ctx.globalAlpha = 1.0;
        break;
      case "underline":
        ctx.fillRect(x, y + cellHeight - 2, cellWidth, 2);
        break;
      case "bar":
        ctx.fillRect(x, y, 2, cellHeight);
        break;
    }
  }

  // =========================================================================
  // Debug overlay
  // =========================================================================
  private toggleDebugOverlay() {
    this.debugOverlay = !this.debugOverlay;
    if (!this.debugOverlay && this.debugEl) {
      this.debugEl.remove();
      this.debugEl = null;
      return;
    }
    if (this.debugOverlay && !this.debugEl) {
      const el = document.createElement("div");
      el.style.cssText =
        "position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.75);" +
        "color:#0f0;font:11px monospace;padding:4px 8px;pointer-events:none;" +
        "z-index:100;border-radius:3px;white-space:pre;";
      this.textCanvas.parentElement?.appendChild(el);
      this.debugEl = el;
    }
  }

  /** Dump VirtualCanvas state vs canvas dimensions to console for debugging. */
  private dumpScreenState() {
    const vc = this.core.virtualCanvas;
    const cols = this.cols;
    const rows = this.rows;
    console.log("=== SCREEN STATE DUMP ===");
    console.log(`Grid: ${cols}x${rows}`);
    console.log(`Cell: ${this.renderer.cellWidth}px x ${this.renderer.cellHeight}px`);
    console.log(`DPR: ${this.dpr}`);
    console.log(`Canvas CSS: ${this.textCanvas.style.width} x ${this.textCanvas.style.height}`);
    console.log(`Canvas pixels: ${this.textCanvas.width} x ${this.textCanvas.height}`);
    console.log(`VC cols: ${vc.cols}, VC rows: ${vc.rows}`);
    console.log(`Cursor: (${this.core.cursor.x}, ${this.core.cursor.y})`);
    console.log(`ViewportOffset: ${this.core.viewportOffset}`);
    console.log(`Alt screen: ${this.core.modes.isAlternateScreen}`);
    console.log(`Dirty bitmap: ${Array.from(vc.dirtyBitmap).join("")}`);

    // Dump first 25 rows of text content from typed arrays
    console.log("--- VC Row Content (typed arrays) ---");
    for (let r = 0; r < Math.min(rows, 25); r++) {
      let text = "";
      for (let c = 0; c < cols; c++) {
        const idx = vc.rowOffset(r) + c;
        const cp = vc.activeChars[idx];
        if (cp === 0) text += " ";
        else if (cp === 0xFFFFFFFF) text += vc.getGraphemeByIndex(idx) ?? "?";
        else text += String.fromCodePoint(cp);
      }
      const trimmed = text.trimEnd();
      if (trimmed.length > 0) {
        console.log(`  r${String(r).padStart(2, "0")}: "${trimmed}"`);
      } else {
        console.log(`  r${String(r).padStart(2, "0")}: (blank)`);
      }
    }
    console.log("=== END DUMP ===");
  }

  private startThroughputTimer() {
    this.throughputTimer = window.setInterval(() => {
      this.throughputWindow.push(this.throughputAccum);
      if (this.throughputWindow.length > 5) this.throughputWindow.shift();
      this.throughputAccum = 0;
    }, 1000);
  }

  private getThroughput(): number {
    if (this.throughputWindow.length === 0) return 0;
    const sum = this.throughputWindow.reduce((a, b) => a + b, 0);
    return sum / this.throughputWindow.length;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / 1048576).toFixed(1)} MB/s`;
  }

  private updateDebugOverlay() {
    if (!this.debugOverlay || !this.debugEl) return;
    if (!(this.renderer instanceof CanvasRenderer)) return;

    const m = (this.renderer as CanvasRenderer).getMetrics();
    const throughput = this.getThroughput();
    this.debugEl.textContent =
      `draw:  ${m.drawTimeMs.toFixed(2)}ms\n` +
      `dirty: ${m.dirtyRows} rows\n` +
      `atlas: ${m.atlasSize} glyphs / ${m.atlasPages} pg\n` +
      `hit:   ${(m.atlasHitRate * 100).toFixed(1)}%\n` +
      `dpr:   ${this.dpr}\n` +
      `input: ${this.lastInputLatency > 0 ? this.lastInputLatency.toFixed(1) + "ms" : "—"}\n` +
      `io:    ${this.formatBytes(throughput)}`;
  }

  // =========================================================================
  // Cursor blink — only redraws the cursor layer
  // =========================================================================
  private startBlink() {
    this.blinkTimer = window.setInterval(() => {
      this.cursorOn = !this.cursorOn;
      this.drawCursorLayer(); // Direct draw — no text layer redraw!
    }, 530);
  }

  private resetBlink() {
    this.cursorOn = true;
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
    this.startBlink();
    this.drawCursorLayer();
  }
}
