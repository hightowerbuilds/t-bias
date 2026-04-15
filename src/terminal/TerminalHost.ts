import { TerminalCore, type SearchMatch } from "./TerminalCore";
import { Selection } from "./Selection";
import { keyboardEventToSequence } from "./input";
import type { IRenderer, SelectionBounds } from "./IRenderer";
import type { TerminalOptions, Theme } from "./types";
import { DEFAULT_THEME } from "./types";
import { CanvasRenderer } from "./Renderer";
import { isHtmlInCanvasSupported } from "./htmlInCanvas";
import { MARK_A } from "./VirtualCanvas";

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

  // URL hover state
  private hoveredUrl: string | null = null;
  private hoveredUrlRow = -1;
  private hoveredUrlStartCol = -1;
  private hoveredUrlEndCol = -1;
  private contextMenu: HTMLDivElement | null = null;

  // HTML-in-Canvas integration
  private htmlInCanvasEnabled = false;
  // A11y: one invisible <div> per viewport row, children of textCanvas
  private a11yRows: HTMLDivElement[] = [];
  // Live-region container for announcing new output to screen readers
  private a11yContainer: HTMLElement | null = null;
  // Link pool: reusable <a> elements for OSC 8 URL spans (accessibility only)
  private linkPool: HTMLAnchorElement[] = [];
  private activeLinkEls: HTMLAnchorElement[] = [];
  // Prompt sections: one <section> per viewport row slot for OSC 133 marks
  private promptSections: HTMLElement[] = [];

  // Search
  private searchBar: HTMLDivElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchCountEl: HTMLSpanElement | null = null;
  private searchMatches: SearchMatch[] = [];
  private searchMatchIndex = -1;
  private searchCaseSensitive = false;
  private searchRegex = false;
  private searchDebounceTimer: number | null = null;

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

    // HTML-in-Canvas: opt-in if the browser supports the WICG proposal.
    // Enables: layoutSubtree children for accessibility, onpaint-driven render loop,
    // OSC 8 <a> elements for screen readers, OSC 133 <section> prompt anchors.
    if (isHtmlInCanvasSupported()) {
      this.htmlInCanvasEnabled = true;
      this.textCanvas.layoutSubtree = true;

      // Semantic role for the whole terminal
      this.textCanvas.setAttribute("role", "application");
      this.textCanvas.setAttribute("aria-label", "Terminal");

      // Build the invisible DOM layers inside textCanvas
      this.buildA11yRows(this.rows);
      this.buildPromptSections(this.rows);

      // Off-canvas live region for announcing new output lines
      this.a11yContainer = document.createElement("div");
      this.a11yContainer.setAttribute("role", "log");
      this.a11yContainer.setAttribute("aria-live", "polite");
      this.a11yContainer.setAttribute("aria-atomic", "false");
      this.a11yContainer.setAttribute("aria-label", "Terminal output");
      this.a11yContainer.style.cssText =
        "position:absolute;width:1px;height:1px;overflow:hidden;" +
        "clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:0;";
      this.textCanvas.parentElement?.appendChild(this.a11yContainer);

      // Wire onpaint — the browser fires this after intersection-observer
      // steps, once per rendering cycle that includes DOM child mutations.
      // We draw pixels here instead of inside the RAF callback so the
      // browser guarantees DOM layout is settled before we read dirty state.
      this.textCanvas.onpaint = (e: PaintEvent) => this.onPaintFired(e);
    }

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

      if (this.htmlInCanvasEnabled) {
        // Rebuild DOM layers with updated cell dimensions and row count.
        // buildA11yRows removes old divs and creates new ones sized for the
        // new cellWidth/cellHeight (renderer.resize has already updated those).
        this.buildA11yRows(this.rows);
        this.buildPromptSections(this.rows);
        // Release pooled links — their pixel positions are now stale.
        this.releaseAllLinks();
      }

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
    if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
    this.searchBar?.remove();
    this.dismissContextMenu();
    this.renderer.dispose();
    this.selectionCanvas?.remove();
    this.cursorCanvas?.remove();

    if (this.htmlInCanvasEnabled) {
      this.textCanvas.onpaint = null;
      for (const div of this.a11yRows) div.remove();
      this.a11yRows = [];
      for (const el of this.promptSections) el.remove();
      this.promptSections = [];
      for (const el of [...this.activeLinkEls, ...this.linkPool]) el.remove();
      this.activeLinkEls = [];
      this.linkPool = [];
      this.a11yContainer?.remove();
      this.a11yContainer = null;
    }
  }

  // =========================================================================
  // Keyboard
  // =========================================================================
  private handleKeyDown = (e: KeyboardEvent) => {
    const modes = this.core.modes;

    // Cmd+F: open search bar (or navigate to next match if already open)
    if (e.metaKey && e.key === "f") {
      e.preventDefault();
      if (this.searchBar) {
        this.navigateMatch(1);
      } else {
        this.openSearch();
      }
      return;
    }

    // ESC: dismiss context menu first, then search bar
    if (e.key === "Escape") {
      if (this.contextMenu) { e.preventDefault(); this.dismissContextMenu(); return; }
      if (this.searchBar) { e.preventDefault(); this.closeSearch(); return; }
    }

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
    // Cmd+Up/Down: jump between shell prompts (OSC 133)
    if (e.metaKey && !e.shiftKey && !modes.isAlternateScreen) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const absRow = this.core.findPrevPrompt();
        if (absRow >= 0) {
          this.core.scrollToPrompt(absRow);
          this.scheduleTextDraw();
          this.scheduleOverlayDraw();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const absRow = this.core.findNextPrompt();
        if (absRow >= 0) {
          this.core.scrollToPrompt(absRow);
          this.scheduleTextDraw();
          this.scheduleOverlayDraw();
        }
        return;
      }
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

    // Cmd+Click: open URL under cursor
    if (e.button === 0 && e.metaKey && !modes.mouseEnabled
        && !modes.isAlternateScreen && this.core.viewportOffset === 0) {
      const url = this.getUrlAtPosition(row, col);
      if (url) {
        e.preventDefault();
        (window as any).__TAURI__.shell.open(url);
        return;
      }
    }

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

    // URL hover detection (only in live view, no mouse protocol, no alt screen)
    if (!modes.mouseEnabled && !modes.isAlternateScreen && this.core.viewportOffset === 0) {
      this.detectHoveredUrl(row, col);
    } else {
      this.clearHoveredUrl();
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

  private handleContextMenu = (e: MouseEvent) => {
    if (this.core.modes.mouseEnabled) { e.preventDefault(); return; }
    e.preventDefault();

    let url: string | null = null;
    if (!this.core.modes.isAlternateScreen && this.core.viewportOffset === 0) {
      url = this.getUrlAtPosition(this.mouseRow(e), this.mouseCol(e));
    }
    this.showContextMenu(e.clientX, e.clientY, url ?? undefined);
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
    if (this.htmlInCanvasEnabled) {
      this.scheduleTextDrawHIC();
    } else {
      this.scheduleTextDrawRAF();
    }
  }

  // --- Baseline RAF path (non-HIC browsers) ---

  private scheduleTextDrawRAF() {
    if (!this.textDrawQueued) {
      this.textDrawQueued = true;
      requestAnimationFrame(() => {
        this.textDrawQueued = false;
        this.flushWriteBuffer();
        this.writesSinceLastFrame = 0;
        this.bytesSinceLastFrame = 0;
        const state = this.core.getRenderState();
        this.renderer.draw(state);
        this.core.virtualCanvas.clearDirty();
        if (this.lastKeypressTime > 0) {
          this.lastInputLatency = performance.now() - this.lastKeypressTime;
          this.lastKeypressTime = 0;
        }
        this.updateDebugOverlay();
      });
    }
  }

  // --- HTML-in-Canvas path ---
  //
  // Flow:
  //   1. scheduleTextDrawHIC() → coalesces into one RAF, same as before
  //   2. RAF: flush PTY writes → parse VT → update DOM layers (a11y, links,
  //      prompts) → call requestPaint() so the browser knows children changed
  //   3. Browser finishes layout + intersection-observer steps
  //   4. onpaint fires (browser-gated) → draw pixels → clearDirty
  //
  // The key difference from pure RAF: pixels are drawn after the browser has
  // settled layout for this frame, eliminating the window where a second dirty
  // mark could slip in between the render-state snapshot and the draw.

  private scheduleTextDrawHIC() {
    if (!this.textDrawQueued) {
      this.textDrawQueued = true;
      requestAnimationFrame(() => {
        this.textDrawQueued = false;

        // 1. Parse all buffered PTY data — updates VirtualCanvas dirty state.
        this.flushWriteBuffer();
        this.writesSinceLastFrame = 0;
        this.bytesSinceLastFrame = 0;
        if (this.lastKeypressTime > 0) {
          this.lastInputLatency = performance.now() - this.lastKeypressTime;
          this.lastKeypressTime = 0;
        }

        // 2. Sync DOM layers (causes browser layout recalculate).
        //    These are the DOM mutations that trigger onpaint.
        this.syncA11yLayer();
        this.syncLinkLayer();
        this.syncPromptAnchors();

        // 3. Ask the browser to fire onpaint after layout/intersection-observer.
        //    onPaintFired() will draw pixels and clear the dirty bitmap.
        this.textCanvas.requestPaint();
      });
    }
  }

  private onPaintFired(_e: PaintEvent) {
    // The browser has processed layout for all child mutations made in the RAF.
    // The dirty bitmap now reflects a stable post-layout state — safe to draw.
    const state = this.core.getRenderState();
    this.renderer.draw(state);
    this.core.virtualCanvas.clearDirty();
    this.updateDebugOverlay();
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

    // OSC 133 exit-status indicators (3px left-edge bar: green = success, red = failure)
    if (!this.core.modes.isAlternateScreen) {
      const dMarks = this.core.getVisibleDMarks();
      for (const { viewportRow, success } of dMarks) {
        ctx.fillStyle = success ? "#6a9955" : "#f44747";
        ctx.globalAlpha = 0.85;
        ctx.fillRect(0, viewportRow * cellHeight + 1, 3, cellHeight - 2);
      }
      ctx.globalAlpha = 1.0;
    }

    // OSC 8 URL underlines + hovered auto-detect URL underline
    if (!this.core.modes.isAlternateScreen && this.core.viewportOffset === 0) {
      const vc = this.core.virtualCanvas;
      ctx.fillStyle = "#569cd6";
      ctx.globalAlpha = 0.85;

      for (let r = 0; r < this.rows; r++) {
        // Scan for contiguous URL spans and draw a 1px underline per span
        let spanStart = -1;
        let spanId = 0;
        for (let c = 0; c <= this.cols; c++) {
          const id = c < this.cols ? vc.getUrlId(r, c) : 0;
          if (id !== spanId) {
            if (spanId !== 0 && spanStart >= 0) {
              ctx.fillRect(
                spanStart * cellWidth,
                r * cellHeight + cellHeight - 2,
                (c - spanStart) * cellWidth,
                1,
              );
            }
            spanId = id;
            spanStart = c;
          }
        }
      }

      // Hovered auto-detect URL (no OSC 8 data at that cell)
      if (this.hoveredUrl !== null && this.hoveredUrlRow >= 0
          && this.hoveredUrlRow < this.rows
          && vc.getUrlId(this.hoveredUrlRow, this.hoveredUrlStartCol) === 0) {
        ctx.fillRect(
          this.hoveredUrlStartCol * cellWidth,
          this.hoveredUrlRow * cellHeight + cellHeight - 2,
          (this.hoveredUrlEndCol - this.hoveredUrlStartCol) * cellWidth,
          1,
        );
      }

      ctx.globalAlpha = 1.0;
    }

    // Search match highlights
    if (this.searchMatches.length > 0 && !this.core.modes.isAlternateScreen) {
      const sbLen = this.core.scrollbackLength;
      const vOffset = this.core.viewportOffset;

      for (let i = 0; i < this.searchMatches.length; i++) {
        const match = this.searchMatches[i];
        const viewportRow = match.absRow - sbLen + vOffset;
        if (viewportRow < 0 || viewportRow >= this.rows) continue;

        const isCurrent = i === this.searchMatchIndex;
        ctx.fillStyle = isCurrent ? "#f0c040" : "#806020";
        ctx.globalAlpha = isCurrent ? 0.7 : 0.4;
        ctx.fillRect(
          match.col * cellWidth,
          viewportRow * cellHeight,
          Math.max(1, match.len) * cellWidth,
          cellHeight,
        );
      }
      ctx.globalAlpha = 1.0;
    }

    // Selection
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
  // URL detection and interaction
  // =========================================================================

  private getUrlAtPosition(screenRow: number, col: number): string | null {
    const osc8 = this.core.virtualCanvas.getUrlAt(screenRow, col);
    if (osc8) return osc8;
    return this.autoDetectUrlAt(screenRow, col)?.url ?? null;
  }

  private autoDetectUrlAt(screenRow: number, col: number): { url: string; startCol: number; endCol: number } | null {
    const rowText = this.core.virtualCanvas.getActiveRowText(screenRow);
    const re = /https?:\/\/[^\s\x00-\x1f\x7f"<>{}|\\^`[\]]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rowText)) !== null) {
      // Trim trailing punctuation that commonly trails URLs
      const url = m[0].replace(/[.,;:!?()'"]+$/, "");
      const startCol = m.index;
      const endCol = startCol + url.length;
      if (col >= startCol && col < endCol) {
        return { url, startCol, endCol };
      }
    }
    return null;
  }

  private detectHoveredUrl(screenRow: number, col: number): void {
    const vc = this.core.virtualCanvas;

    // Check OSC 8 URL first — find the contiguous span of the same URL ID
    const urlId = vc.getUrlId(screenRow, col);
    if (urlId !== 0) {
      let start = col, end = col + 1;
      while (start > 0 && vc.getUrlId(screenRow, start - 1) === urlId) start--;
      while (end < this.cols && vc.getUrlId(screenRow, end) === urlId) end++;
      const url = vc.getUrlStr(urlId);
      this.setHoveredUrl(url, screenRow, start, end);
      return;
    }

    // Fall back to auto-detect
    const detected = this.autoDetectUrlAt(screenRow, col);
    if (detected) {
      this.setHoveredUrl(detected.url, screenRow, detected.startCol, detected.endCol);
      return;
    }

    this.clearHoveredUrl();
  }

  private setHoveredUrl(url: string, row: number, startCol: number, endCol: number): void {
    const changed = url !== this.hoveredUrl || row !== this.hoveredUrlRow
                    || startCol !== this.hoveredUrlStartCol;
    this.hoveredUrl = url;
    this.hoveredUrlRow = row;
    this.hoveredUrlStartCol = startCol;
    this.hoveredUrlEndCol = endCol;
    (this.cursorCanvas ?? this.textCanvas).style.cursor = "pointer";
    if (changed) this.scheduleOverlayDraw();
  }

  private clearHoveredUrl(): void {
    if (this.hoveredUrl === null) return;
    this.hoveredUrl = null;
    this.hoveredUrlRow = -1;
    this.hoveredUrlStartCol = -1;
    this.hoveredUrlEndCol = -1;
    (this.cursorCanvas ?? this.textCanvas).style.cursor = "";
    this.scheduleOverlayDraw();
  }

  private showContextMenu(x: number, y: number, url?: string): void {
    this.dismissContextMenu();

    const menu = document.createElement("div");
    // Will reposition after measuring; start off-screen to measure height
    menu.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;z-index:300;" +
      "background:#2d2d2d;border:1px solid #555;border-radius:4px;" +
      "font-family:system-ui,sans-serif;font-size:13px;min-width:160px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.5);overflow:hidden;";

    const makeItem = (label: string, action: () => void, disabled = false): HTMLDivElement => {
      const item = document.createElement("div");
      item.textContent = label;
      item.style.cssText = `padding:6px 14px;color:${disabled ? "#666" : "#d4d4d4"};` +
        `cursor:${disabled ? "default" : "pointer"};`;
      if (!disabled) {
        item.addEventListener("mouseenter", () => { item.style.background = "#3a3a3a"; });
        item.addEventListener("mouseleave", () => { item.style.background = ""; });
        item.addEventListener("click", () => { action(); this.dismissContextMenu(); });
      }
      return item;
    };

    const makeSeparator = (): HTMLDivElement => {
      const sep = document.createElement("div");
      sep.style.cssText = "margin:3px 0;border-top:1px solid #444;";
      return sep;
    };

    const hasSelection = this.selection.active;
    const selectedText = hasSelection ? this.core.getSelectedText(this.selection) : "";

    // Copy (only when selection exists)
    if (hasSelection) {
      menu.appendChild(makeItem("Copy", () => {
        navigator.clipboard.writeText(selectedText);
        this.selection.clear();
        this.scheduleOverlayDraw();
      }));
    }

    // Paste
    menu.appendChild(makeItem("Paste", () => {
      navigator.clipboard.readText().then(text => {
        if (!text) return;
        if (this.core.modes.bracketedPaste) {
          this.onData?.("\x1b[200~" + text + "\x1b[201~");
        } else {
          this.onData?.(text);
        }
      });
    }));

    menu.appendChild(makeSeparator());

    // Select All
    menu.appendChild(makeItem("Select All", () => {
      this.selection.start(0, 0);
      this.selection.update(this.cols - 1, this.rows - 1);
      this.selection.finish();
      this.scheduleOverlayDraw();
    }));

    // Search (pre-fills with selected text if any)
    menu.appendChild(makeItem("Search…", () => {
      this.openSearch();
      if (selectedText && this.searchInput) {
        this.searchInput.value = selectedText;
        this.runSearch();
      }
    }));

    // Clear Scrollback
    menu.appendChild(makeItem("Clear Scrollback", () => {
      this.core.clearScrollback();
      this.scheduleTextDraw();
      this.scheduleOverlayDraw();
    }));

    // URL section
    if (url) {
      menu.appendChild(makeSeparator());
      menu.appendChild(makeItem("Open Link", () => {
        (window as any).__TAURI__.shell.open(url);
      }));
      menu.appendChild(makeItem("Copy Link", () => {
        navigator.clipboard.writeText(url);
      }));
    }

    document.body.appendChild(menu);
    this.contextMenu = menu;

    // Position: prefer below+right, flip if near viewport edge
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 200;
    const left = x + mw > vw ? Math.max(0, vw - mw - 4) : x;
    const top  = y + mh > vh ? Math.max(0, y - mh) : y;
    menu.style.left = `${left}px`;
    menu.style.top  = `${top}px`;

    // Dismiss on any click or ESC outside the menu
    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        this.dismissContextMenu();
        document.removeEventListener("click", dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener("click", dismiss, true), 0);
  }

  private dismissContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  // =========================================================================
  // Search
  // =========================================================================

  private openSearch(): void {
    if (this.searchBar) {
      this.searchInput?.focus();
      return;
    }
    const container = this.textCanvas.parentElement;
    if (!container) return;

    const bar = document.createElement("div");
    bar.style.cssText =
      "position:absolute;top:0;left:0;right:0;z-index:200;" +
      "display:flex;align-items:center;gap:4px;padding:4px 8px;" +
      "background:rgba(30,30,30,0.95);border-bottom:1px solid #444;" +
      "font-family:system-ui,sans-serif;font-size:13px;box-sizing:border-box;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find…";
    input.style.cssText =
      "flex:1;background:#2d2d2d;color:#d4d4d4;border:1px solid #555;" +
      "border-radius:3px;padding:3px 7px;font-size:13px;outline:none;min-width:0;";

    const countEl = document.createElement("span");
    countEl.style.cssText =
      "color:#888;font-size:12px;min-width:64px;text-align:right;white-space:nowrap;";
    countEl.textContent = "No results";

    const makeBtn = (label: string, title: string): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.title = title;
      btn.style.cssText =
        "background:#2d2d2d;color:#888;border:1px solid #555;border-radius:3px;" +
        "padding:2px 6px;cursor:pointer;font-size:12px;flex-shrink:0;";
      return btn;
    };

    const prevBtn = makeBtn("↑", "Previous match (Shift+Enter)");
    const nextBtn = makeBtn("↓", "Next match (Enter)");
    const caseBtn = makeBtn("Aa", "Case sensitive");
    const regexBtn = makeBtn(".*", "Regular expression");
    const closeBtn = makeBtn("×", "Close (Esc)");
    closeBtn.style.marginLeft = "4px";

    const syncToggleStyles = () => {
      caseBtn.style.color  = this.searchCaseSensitive ? "#d4d4d4" : "#888";
      caseBtn.style.borderColor = this.searchCaseSensitive ? "#569cd6" : "#555";
      regexBtn.style.color = this.searchRegex ? "#d4d4d4" : "#888";
      regexBtn.style.borderColor = this.searchRegex ? "#569cd6" : "#555";
    };
    syncToggleStyles();

    input.addEventListener("input", () => {
      if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = window.setTimeout(() => this.runSearch(), 80);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); this.closeSearch(); return; }
      if (e.key === "Enter") { e.preventDefault(); this.navigateMatch(e.shiftKey ? -1 : 1); }
    });

    prevBtn.addEventListener("click", () => this.navigateMatch(-1));
    nextBtn.addEventListener("click", () => this.navigateMatch(1));

    caseBtn.addEventListener("click", () => {
      this.searchCaseSensitive = !this.searchCaseSensitive;
      syncToggleStyles();
      this.runSearch();
    });

    regexBtn.addEventListener("click", () => {
      this.searchRegex = !this.searchRegex;
      syncToggleStyles();
      this.runSearch();
    });

    closeBtn.addEventListener("click", () => this.closeSearch());

    bar.append(input, countEl, prevBtn, nextBtn, caseBtn, regexBtn, closeBtn);
    container.appendChild(bar);

    this.searchBar = bar;
    this.searchInput = input;
    this.searchCountEl = countEl;

    input.focus();
  }

  private closeSearch(): void {
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.searchBar?.remove();
    this.searchBar = null;
    this.searchInput = null;
    this.searchCountEl = null;
    this.searchMatches = [];
    this.searchMatchIndex = -1;
    this.scheduleOverlayDraw();
    this.focus();
  }

  private runSearch(): void {
    const query = this.searchInput?.value ?? "";
    if (!query) {
      this.searchMatches = [];
      this.searchMatchIndex = -1;
      if (this.searchCountEl) this.searchCountEl.textContent = "No results";
      this.scheduleOverlayDraw();
      return;
    }

    this.searchMatches = this.core.search(query, this.searchCaseSensitive, this.searchRegex);

    if (this.searchMatches.length === 0) {
      this.searchMatchIndex = -1;
      if (this.searchCountEl) this.searchCountEl.textContent = "No results";
      this.scheduleOverlayDraw();
      return;
    }

    // Jump to the first match at or after the top of the current viewport
    const sbLen = this.core.scrollbackLength;
    const firstVisibleAbs = sbLen - this.core.viewportOffset;
    let bestIdx = 0;
    for (let i = 0; i < this.searchMatches.length; i++) {
      if (this.searchMatches[i].absRow >= firstVisibleAbs) { bestIdx = i; break; }
    }
    this.searchMatchIndex = bestIdx;
    this.scrollToMatch(bestIdx);
    this.updateSearchCount();
    this.scheduleOverlayDraw();
  }

  private navigateMatch(delta: number): void {
    if (this.searchMatches.length === 0) return;
    const n = this.searchMatches.length;
    this.searchMatchIndex = ((this.searchMatchIndex + delta) % n + n) % n;
    this.scrollToMatch(this.searchMatchIndex);
    this.updateSearchCount();
    this.scheduleOverlayDraw();
  }

  private scrollToMatch(index: number): void {
    const match = this.searchMatches[index];
    if (!match) return;
    const sbLen = this.core.scrollbackLength;

    let targetOffset: number;
    if (match.absRow < sbLen) {
      // Scrollback: center the match in the viewport
      targetOffset = Math.max(0, Math.min(sbLen, sbLen - match.absRow + Math.floor(this.rows / 2)));
    } else {
      // Active buffer: reset to live view
      targetOffset = 0;
    }

    this.core.scrollViewport(targetOffset - this.core.viewportOffset);
    this.scheduleTextDraw();
  }

  private updateSearchCount(): void {
    if (!this.searchCountEl) return;
    const n = this.searchMatches.length;
    this.searchCountEl.textContent =
      n === 0 ? "No results" : `${this.searchMatchIndex + 1} of ${n}`;
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
      `io:    ${this.formatBytes(throughput)}\n` +
      `hic:   ${this.htmlInCanvasEnabled ? "on" : "off"}`;
  }

  // =========================================================================
  // HTML-in-Canvas — A11y layer
  // =========================================================================
  // Invisible <div> children of textCanvas.  Each maps to one viewport row.
  // They exist purely for the browser's accessibility tree — screen readers
  // navigate them and read the text content.  We never call drawElementImage
  // on these; the GlyphAtlas still paints the visible pixels.

  private buildA11yRows(rowCount: number) {
    for (const div of this.a11yRows) div.remove();
    this.a11yRows = [];

    const { cellWidth, cellHeight } = this.renderer;

    for (let r = 0; r < rowCount; r++) {
      const div = document.createElement("div");
      div.setAttribute("aria-hidden", "false");
      div.style.cssText = [
        "position:absolute",
        `top:${r * cellHeight}px`,
        "left:0",
        `width:${this.cols * cellWidth}px`,
        `height:${cellHeight}px`,
        "white-space:pre",
        // Visually invisible but in the accessibility tree:
        "color:transparent",
        "pointer-events:none",
        "user-select:none",
        `font-family:${this.renderer instanceof CanvasRenderer
          ? (this.renderer as any).fontFamily ?? "monospace"
          : "monospace"}`,
        `font-size:${this.fontSize}px`,
        `line-height:${cellHeight}px`,
      ].join(";");
      this.textCanvas.appendChild(div);
      this.a11yRows.push(div);
    }
  }

  private syncA11yLayer() {
    if (!this.htmlInCanvasEnabled) return;
    const vc = this.core.virtualCanvas;
    const { cellWidth, cellHeight } = this.renderer;

    for (let r = 0; r < this.rows; r++) {
      const div = this.a11yRows[r];
      if (!div) continue;

      // Only update rows that the VT emulator dirtied this frame.
      // dirtyBitmap is read BEFORE clearDirty() so it still reflects changes.
      if (!vc.dirtyBitmap[r] && div.dataset.synced === "1") continue;

      div.textContent = vc.getActiveRowText(r);
      div.dataset.synced = "1";

      // Re-apply geometry in case of font/resize changes
      div.style.top = `${r * cellHeight}px`;
      div.style.width = `${this.cols * cellWidth}px`;
      div.style.height = `${cellHeight}px`;
      div.style.fontSize = `${this.fontSize}px`;
      div.style.lineHeight = `${cellHeight}px`;
    }
  }

  // =========================================================================
  // HTML-in-Canvas — OSC 8 link layer (accessibility)
  // =========================================================================
  // Reusable <a> elements positioned over OSC 8 URL spans.  They are children
  // of textCanvas (participating in layoutSubtree accessibility tree) but are
  // visually transparent.  Mouse interaction still uses the existing
  // detectHoveredUrl / handleMouseDown path because cursorCanvas sits on top.
  // Screen readers, however, see the <a> elements and can activate them.

  private acquireLink(): HTMLAnchorElement {
    let el = this.linkPool.pop();
    if (!el) {
      el = document.createElement("a");
      el.style.cssText = [
        "position:absolute",
        "display:block",
        "color:transparent",
        "text-decoration:none",
        "cursor:pointer",
        "pointer-events:none",  // cursorCanvas intercepts mouse; this is a11y-only
      ].join(";");
      this.textCanvas.appendChild(el);
    }
    return el;
  }

  private releaseAllLinks() {
    for (const el of this.activeLinkEls) {
      el.style.display = "none";
      this.linkPool.push(el);
    }
    this.activeLinkEls = [];
  }

  private syncLinkLayer() {
    if (!this.htmlInCanvasEnabled) return;
    const modes = this.core.modes;

    // Links only relevant in live view of the main screen
    if (modes.isAlternateScreen || this.core.viewportOffset !== 0) {
      this.releaseAllLinks();
      return;
    }

    this.releaseAllLinks();

    const vc = this.core.virtualCanvas;
    const { cellWidth, cellHeight } = this.renderer;

    for (let r = 0; r < this.rows; r++) {
      let spanStart = -1;
      let spanId = 0;

      for (let c = 0; c <= this.cols; c++) {
        const id = c < this.cols ? vc.getUrlId(r, c) : 0;

        if (id !== spanId) {
          // Flush the completed span
          if (spanId !== 0 && spanStart >= 0) {
            const url = vc.getUrlStr(spanId);
            if (url) {
              const el = this.acquireLink();
              el.href = url;
              el.setAttribute("aria-label", url);
              el.title = url;
              el.style.display = "block";
              el.style.left = `${spanStart * cellWidth}px`;
              el.style.top = `${r * cellHeight}px`;
              el.style.width = `${(c - spanStart) * cellWidth}px`;
              el.style.height = `${cellHeight}px`;
              this.activeLinkEls.push(el);
            }
          }
          spanId = id;
          spanStart = c;
        }
      }
    }
  }

  // =========================================================================
  // HTML-in-Canvas — OSC 133 prompt section layer (accessibility)
  // =========================================================================
  // One <section> element per viewport row slot.  When a row has a MARK_A
  // prompt mark, the section is made visible and labelled; otherwise hidden.
  // Screen readers announce "Shell prompt" at each prompt position.
  // Visual exit-status bars remain in drawSelectionLayer (unchanged).

  private buildPromptSections(rowCount: number) {
    for (const el of this.promptSections) el.remove();
    this.promptSections = [];

    const { cellWidth, cellHeight } = this.renderer;

    for (let r = 0; r < rowCount; r++) {
      const el = document.createElement("section");
      el.setAttribute("aria-label", "Shell prompt");
      el.setAttribute("aria-hidden", "true"); // hidden until a prompt is here
      el.style.cssText = [
        "position:absolute",
        `top:${r * cellHeight}px`,
        "left:0",
        `width:${this.cols * cellWidth}px`,
        `height:${cellHeight}px`,
        "color:transparent",
        "pointer-events:none",
      ].join(";");
      this.textCanvas.appendChild(el);
      this.promptSections.push(el);
    }
  }

  private syncPromptAnchors() {
    if (!this.htmlInCanvasEnabled) return;
    if (this.core.modes.isAlternateScreen) return;

    const vc = this.core.virtualCanvas;
    const { cellWidth, cellHeight } = this.renderer;

    for (let r = 0; r < this.rows; r++) {
      const el = this.promptSections[r];
      if (!el) continue;

      const mark = vc.getPromptMark(r);
      if (mark === MARK_A) {
        el.setAttribute("aria-hidden", "false");
        // Keep position in sync with current cell dimensions
        el.style.top = `${r * cellHeight}px`;
        el.style.width = `${this.cols * cellWidth}px`;
        el.style.height = `${cellHeight}px`;
      } else {
        el.setAttribute("aria-hidden", "true");
      }
    }
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
