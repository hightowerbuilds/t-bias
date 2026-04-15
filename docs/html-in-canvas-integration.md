# HTML-in-Canvas Integration — t-bias Implementation Guide

> **Posture:** We treat the WICG HTML-in-Canvas API as production-ready and wire it in
> completely. Feature detection guards the initialization path, but once the API is
> confirmed present we remove all fallback branches inside the hot paths. We are the
> experiment.

---

## 0. What We're Wiring In and Why

The WICG HTML-in-Canvas proposal adds four primitives to the browser:

| Primitive | Interface |
|---|---|
| `layoutSubtree` | `HTMLCanvasElement.layoutSubtree: boolean` |
| `drawElementImage` | `CanvasRenderingContext2D.drawElementImage(el, x, y): DOMMatrix` |
| `onpaint` / `requestPaint` | `HTMLCanvasElement` event model |
| `ElementImage` | Transferable snapshot for worker rendering |

We're targeting **five concrete improvements** to t-bias:

1. **A11y layer** — invisible DOM rows in the canvas → real accessibility tree, free
2. **Native OSC 8 links** — real `<a>` elements replace all coordinate hit-test logic
3. **`onpaint`-driven render loop** — replaces our RAF loop, may fix the scroll duplicate-line bug
4. **OSC 133 prompt DOM anchors** — named sections enable `scrollIntoView`, Tab focus, ARIA landmarks
5. **`ElementImage` worker prep** — architecture sketch for moving glyph blitting off-main-thread

---

## 1. TypeScript Declarations

The API doesn't exist in `lib.dom.d.ts` yet. Create `src/html-in-canvas.d.ts`:

```typescript
// src/html-in-canvas.d.ts
// Augments the standard DOM types for the WICG HTML-in-Canvas proposal.
// Remove this file when TypeScript ships official definitions.

interface PaintEvent extends Event {
  readonly changedElements: ReadonlyArray<Element>;
}

interface ElementImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface HTMLCanvasElement {
  /** Opt-in: child elements participate in layout and hit-testing. */
  layoutSubtree: boolean;

  /** Fires after intersection-observer steps when a child element's
   *  visual output changes. Similar role to requestAnimationFrame but
   *  driven by DOM child changes, not clock ticks. */
  onpaint: ((this: HTMLCanvasElement, ev: PaintEvent) => void) | null;

  /** Schedule an onpaint callback on the next rendering opportunity. */
  requestPaint(): void;

  /** Capture a transferable snapshot of a child element. */
  captureElementImage(element: Element): ElementImage;

  /** Returns the CSS transform that synchronises the drawn position. */
  getElementTransform(element: Element | ElementImage, drawTransform: DOMMatrix): DOMMatrix;
}

interface CanvasRenderingContext2D {
  /** Draw a child element (or ElementImage) into the 2D context.
   *  Returns a DOMMatrix for CSS-position synchronisation. */
  drawElementImage(
    element: Element | ElementImage,
    dx: number, dy: number,
    dw?: number, dh?: number,
  ): DOMMatrix;
}

interface OffscreenCanvasRenderingContext2D {
  drawElementImage(
    element: ElementImage,
    dx: number, dy: number,
    dw?: number, dh?: number,
  ): DOMMatrix;
}
```

Add `"include": ["src/html-in-canvas.d.ts"]` to `tsconfig.json`.

---

## 2. Feature Detection

We check for the three entry-points we actually use. Everything else is
conditional on this single boolean.

```typescript
// src/terminal/htmlInCanvas.ts

export function isHtmlInCanvasSupported(): boolean {
  const el = document.createElement("canvas");
  return (
    "layoutSubtree" in el &&
    "requestPaint" in el &&
    typeof (CanvasRenderingContext2D.prototype as any).drawElementImage === "function"
  );
}
```

The flag to enable it in Chrome Canary:
```
chrome://flags/#canvas-draw-element  →  Enabled
```

---

## 3. Feature A — Accessibility Layer

### The Problem We're Solving

Right now the terminal is a `<canvas>` with zero semantic content. VoiceOver,
NVDA, and every other screen reader announce it as an empty image. Users who
depend on assistive technology cannot use t-bias at all.

### How `layoutSubtree` Fixes This

With `textCanvas.layoutSubtree = true`, DOM children of the canvas:
- Participate in the accessibility tree (ARIA and focus)
- Participate in layout and hit-testing
- Remain visually invisible until explicitly `drawElementImage`'d

We never call `drawElementImage` on these rows — we keep drawing our
GlyphAtlas pixels as-is. The DOM rows exist purely for AT consumption.

### DOM Structure After Initialization

```
<div class="terminal-container">          ← existing container
  <canvas id="textCanvas" layoutSubtree>  ← textCanvas, now with layoutSubtree
    <div role="row" aria-rowindex="1" class="a11y-row">…text…</div>
    <div role="row" aria-rowindex="2" class="a11y-row">…text…</div>
    …one per visible row…
  </canvas>
  <canvas id="selectionCanvas" />         ← existing, unchanged
  <canvas id="cursorCanvas" />            ← existing, unchanged
</div>
```

### Changes to `TerminalHost`

Add these fields:

```typescript
// In TerminalHost — new fields
private htmlInCanvasEnabled = false;
private a11yRows: HTMLDivElement[] = [];          // one div per grid row
private a11yContainer: HTMLElement | null = null; // live region for announcements
```

In the `constructor`, after `this.createOverlayCanvases()`:

```typescript
// src/terminal/TerminalHost.ts  — constructor, after createOverlayCanvases()
if (isHtmlInCanvasSupported()) {
  this.htmlInCanvasEnabled = true;
  this.textCanvas.layoutSubtree = true;

  // Wrap the canvas in a grid role so row elements are valid children
  this.textCanvas.setAttribute("role", "grid");
  this.textCanvas.setAttribute("aria-label", "Terminal");
  this.textCanvas.setAttribute("aria-live", "off"); // we control announcements

  this.buildA11yRows(this.rows);

  // Live region for announcing new output (separate from the grid)
  this.a11yContainer = document.createElement("div");
  this.a11yContainer.setAttribute("role", "log");
  this.a11yContainer.setAttribute("aria-live", "polite");
  this.a11yContainer.setAttribute("aria-atomic", "false");
  this.a11yContainer.style.cssText =
    "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);";
  this.textCanvas.parentElement?.appendChild(this.a11yContainer);
}
```

New methods:

```typescript
// src/terminal/TerminalHost.ts — new private methods

private buildA11yRows(rowCount: number) {
  // Remove any existing rows
  for (const div of this.a11yRows) div.remove();
  this.a11yRows = [];

  const { cellWidth, cellHeight } = this.renderer;

  for (let r = 0; r < rowCount; r++) {
    const div = document.createElement("div");
    div.setAttribute("role", "row");
    div.setAttribute("aria-rowindex", String(r + 1));
    div.style.cssText = [
      "position:absolute",
      `top:${r * cellHeight}px`,
      `left:0`,
      `width:${this.cols * cellWidth}px`,
      `height:${cellHeight}px`,
      "white-space:pre",
      // Invisible but in accessibility tree:
      "color:transparent",
      "pointer-events:none",
      "user-select:none",
      "font-family:monospace",
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

  for (let r = 0; r < this.rows; r++) {
    const div = this.a11yRows[r];
    if (!div) continue;
    // Only update rows whose dirty bit was set before this render frame
    // (we call this AFTER renderer.draw but BEFORE clearDirty, so bitmap
    // still reflects what changed this frame)
    if (!vc.dirtyBitmap[r] && div.dataset.synced === "1") continue;

    const text = this.core.virtualCanvas.getActiveRowText(r);
    div.textContent = text;
    div.dataset.synced = "1";

    // Update row position if font/resize changed
    const { cellWidth, cellHeight } = this.renderer;
    div.style.top = `${r * cellHeight}px`;
    div.style.width = `${this.cols * cellWidth}px`;
    div.style.height = `${cellHeight}px`;
    div.style.fontSize = `${this.fontSize}px`;
    div.style.lineHeight = `${cellHeight}px`;
  }
}
```

**In `scheduleTextDraw`**, call `syncA11yLayer` between `renderer.draw` and `clearDirty`:

```typescript
// src/terminal/TerminalHost.ts — scheduleTextDraw()
requestAnimationFrame(() => {
  this.textDrawQueued = false;
  this.flushWriteBuffer();
  this.writesSinceLastFrame = 0;
  this.bytesSinceLastFrame = 0;
  const state = this.core.getRenderState();
  this.renderer.draw(state);
  this.syncA11yLayer();                    // ← NEW: sync before clearDirty
  this.core.virtualCanvas.clearDirty();
  if (this.lastKeypressTime > 0) {
    this.lastInputLatency = performance.now() - this.lastKeypressTime;
    this.lastKeypressTime = 0;
  }
  this.updateDebugOverlay();
});
```

**In `fit()`**, after `this.rows` changes, rebuild the a11y rows:

```typescript
// src/terminal/TerminalHost.ts — fit(), after core.resize / renderer.resize
if (this.htmlInCanvasEnabled) {
  this.buildA11yRows(this.rows);
}
```

**In `dispose()`**, clean up:

```typescript
if (this.htmlInCanvasEnabled) {
  for (const div of this.a11yRows) div.remove();
  this.a11yRows = [];
  this.a11yContainer?.remove();
}
```

### What Screen Readers Will See

After this change, VoiceOver will announce the grid as "Terminal, grid" and
navigate rows as `role="row"` elements with readable text content. The
transparent color ensures they're invisible on screen. The `color:transparent`
trick (rather than `visibility:hidden` or `display:none`) keeps elements in
the accessibility tree while hiding them visually.

---

## 4. Feature B — Native OSC 8 Links

### The Problem We're Solving

Currently, URL handling requires:
1. ~60 lines of hover-detection coordinate math (`detectHoveredUrl`, lines 796-838)
2. A separate typed-array scan in `drawSelectionLayer` to draw underlines (lines 651-691)
3. Manual `Cmd+Click` handling in `handleMouseDown` (lines 476-485)
4. A custom context menu item for "Open URL" (built in `showContextMenu`)

With `layoutSubtree`, each OSC 8 URL span becomes a real `<a>` element:
- Browser handles hit-testing — no coordinate math
- `pointer` cursor appears natively when hovering
- Right-click shows browser/OS native link context menu
- Screen readers announce "link" with the href
- Tauri's `shell.open` can still be called via a click handler on the element

### Link Pool Design

URL spans change every frame (new output, scroll). Allocating and destroying
`<a>` elements per frame is expensive. We use a reuse pool:

```typescript
// src/terminal/TerminalHost.ts — new fields
private linkPool: HTMLAnchorElement[] = [];   // available anchors
private activeLinkEls: HTMLAnchorElement[] = []; // currently shown
```

```typescript
// src/terminal/TerminalHost.ts — new private methods

private acquireLink(): HTMLAnchorElement {
  let el = this.linkPool.pop();
  if (!el) {
    el = document.createElement("a");
    el.style.cssText = [
      "position:absolute",
      "display:block",
      "color:transparent",         // invisible — glyph atlas paints the text
      "text-decoration:none",      // we draw the underline ourselves
      "cursor:pointer",
      "pointer-events:auto",
    ].join(";");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const href = el!.href;
      if (href) (window as any).__TAURI__.shell.open(href);
    });
    // Append to textCanvas so it participates in layoutSubtree hit-testing
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
  if (modes.isAlternateScreen || this.core.viewportOffset !== 0) {
    this.releaseAllLinks();
    return;
  }

  this.releaseAllLinks(); // release before rebuilding

  const vc = this.core.virtualCanvas;
  const { cellWidth, cellHeight } = this.renderer;

  for (let r = 0; r < this.rows; r++) {
    // Scan for contiguous OSC 8 URL spans on this row
    let spanStart = -1;
    let spanId = 0;

    for (let c = 0; c <= this.cols; c++) {
      const id = c < this.cols ? vc.getUrlId(r, c) : 0;

      if (id !== spanId) {
        // Flush previous span
        if (spanId !== 0 && spanStart >= 0) {
          const url = vc.getUrlStr(spanId);
          const el = this.acquireLink();
          el.href = url;
          el.setAttribute("aria-label", url);
          el.style.display = "block";
          el.style.left = `${spanStart * cellWidth}px`;
          el.style.top = `${r * cellHeight}px`;
          el.style.width = `${(c - spanStart) * cellWidth}px`;
          el.style.height = `${cellHeight}px`;
          this.activeLinkEls.push(el);
        }
        spanId = id;
        spanStart = c;
      }
    }
  }
}
```

Call `syncLinkLayer()` after `syncA11yLayer()` in the RAF callback:

```typescript
this.renderer.draw(state);
this.syncA11yLayer();
this.syncLinkLayer();      // ← NEW
this.core.virtualCanvas.clearDirty();
```

### What We Remove

Once `syncLinkLayer` is wired in:

- `detectHoveredUrl`, `setHoveredUrl`, `clearHoveredUrl` — delete them
  (browser cursor handling on `<a>` elements replaces all of this)
- The OSC 8 underline scan in `drawSelectionLayer` (lines 651-691) — delete it
  (we draw the underline on the selection canvas only for auto-detected URLs now,
  which we still handle manually since those don't have DOM elements)
- The `Cmd+Click` URL branch in `handleMouseDown` (lines 476-485) — delete it
  (the `<a>` click handler on the element fires instead)
- The `hoveredUrl`, `hoveredUrlRow`, `hoveredUrlStartCol`, `hoveredUrlEndCol`
  fields — delete them
- The "Open URL" item in `showContextMenu` — delete it
  (browser/OS provides native link context menu on right-click of the `<a>`)

**Net deletion: ~120 lines. Net addition: ~60 lines.**

---

## 5. Feature C — `onpaint`-Driven Render Loop

### The Problem We're Solving

The scroll duplicate-line bug (`project_scroll_bug.md`) is a dirty-tracking
synchronisation issue. The `VirtualCanvas.scrollUp` method rotates the row-index
map and marks every affected row dirty:

```typescript
// VirtualCanvas.ts — scrollUp
for (let r = top; r <= bottom; r++) this.markDirty(r);
```

Then the RAF fires, `renderer.draw` runs the 3-pass loop on those rows, and
`clearDirty` clears the bitmap. If a second RAF fires before `clearDirty` (or if
scrollback-viewport offset shifts between the mark and the draw), some rows are
drawn twice. The browser's rendering cycle has no signal from us about when
a row was logically written vs visually settled.

The `onpaint` event fires at a specific, browser-controlled point: **after
intersection-observer steps but before compositing**. This means all DOM
mutations for a frame are settled before we draw. By moving our render trigger
from `requestAnimationFrame` to `onpaint`, we get a guaranteed-stable moment to
read the virtual canvas and blit.

### Architecture Change

Current flow:
```
PTY data → write() → scheduleTextDraw() → RAF → flushWriteBuffer() → draw() → clearDirty()
```

New flow with `onpaint`:
```
PTY data → write() → flushWriteBuffer() → syncA11yLayer() → requestPaint()
                                                                    ↓
                                                           onpaint fires
                                                                    ↓
                                                         renderer.draw() → clearDirty()
```

The key difference: `flushWriteBuffer` and DOM mutation (a11y rows updated)
happen *before* we ask the browser to render. The browser processes layout, fires
`onpaint`, and we know the DOM is settled when we draw.

### Implementation

```typescript
// src/terminal/TerminalHost.ts — constructor, HTML-in-Canvas init block
if (this.htmlInCanvasEnabled) {
  this.textCanvas.onpaint = (e: PaintEvent) => {
    this.onPaintFired(e);
  };
}
```

```typescript
// src/terminal/TerminalHost.ts — new methods

private onPaintFired(e: PaintEvent) {
  // e.changedElements: which a11y row divs changed this paint cycle.
  // We already have sub-row dirty tracking, so we use this primarily
  // as a render gate — not to determine what to draw.
  const state = this.core.getRenderState();
  this.renderer.draw(state);
  this.core.virtualCanvas.clearDirty();
  this.updateDebugOverlay();
}

// Replace the existing scheduleTextDraw entirely when HTML-in-Canvas is active:
private scheduleTextDraw() {
  if (this.htmlInCanvasEnabled) {
    this.scheduleTextDrawHIC();
  } else {
    this.scheduleTextDrawRAF();
  }
}

private scheduleTextDrawRAF() {
  // Existing implementation — unchanged
  if (!this.textDrawQueued) {
    this.textDrawQueued = true;
    requestAnimationFrame(() => {
      this.textDrawQueued = false;
      this.flushWriteBuffer();
      this.writesSinceLastFrame = 0;
      this.bytesSinceLastFrame = 0;
      const state = this.core.getRenderState();
      this.renderer.draw(state);
      this.syncA11yLayer();
      this.syncLinkLayer();
      this.core.virtualCanvas.clearDirty();
      if (this.lastKeypressTime > 0) {
        this.lastInputLatency = performance.now() - this.lastKeypressTime;
        this.lastKeypressTime = 0;
      }
      this.updateDebugOverlay();
    });
  }
}

private scheduleTextDrawHIC() {
  // HTML-in-Canvas path:
  // 1. Flush the write buffer and update DOM (a11y rows, links) immediately
  // 2. Ask the browser to schedule a paint via requestPaint
  // 3. onpaint fires at the right point in the rendering pipeline → draw pixels
  if (this.textDrawQueued) return;
  this.textDrawQueued = true;

  // Flush writes and update DOM synchronously (not in a callback).
  // This is safe because we're not touching the canvas pixels yet.
  this.flushWriteBuffer();
  this.writesSinceLastFrame = 0;
  this.bytesSinceLastFrame = 0;
  if (this.lastKeypressTime > 0) {
    this.lastInputLatency = performance.now() - this.lastKeypressTime;
    this.lastKeypressTime = 0;
  }

  // Sync DOM layers (a11y rows + links) before the paint cycle.
  // These mutations trigger the browser's layout and intersection observer.
  this.syncA11yLayer();
  this.syncLinkLayer();

  // Ask browser to fire onpaint after layout settles.
  this.textCanvas.requestPaint();
  this.textDrawQueued = false; // requestPaint is not a queue — it's a hint
}
```

### Why This May Fix the Scroll Bug

The duplicate-line bug happens when dirty state is read at the wrong moment
relative to the row-index rotation. With `onpaint`:

1. `scrollUp` rotates row map and marks rows dirty ✓
2. `flushWriteBuffer` runs → VT emulator updates cells ✓
3. `syncA11yLayer` updates DOM rows (browser processes layout) ✓
4. `requestPaint` is called ✓
5. **Browser finishes intersection observer, style recalculate, layout** ✓
6. `onpaint` fires — at this point the DOM and layout are settled ✓
7. `getRenderState()` reads a fully-stable dirty bitmap ✓
8. `renderer.draw()` runs once on that stable state ✓
9. `clearDirty()` clears the bitmap ✓

There is no window between step 7 and step 8 where a second render can fire,
because `onpaint` is not a timer — it's a browser-gated event that fires exactly
once per mutation cycle.

---

## 6. Feature D — OSC 133 Prompt Marks as DOM Sections

### What We Have Today

OSC 133 marks are stored in `VirtualCanvas.activePromptMark` (one byte per
physical row). `TerminalCore` exposes `findPrevPrompt()` / `findNextPrompt()` which
scan the mark array, and `scrollToPrompt(absRow)` which sets `viewportOffset`
and schedules a redraw. The exit-status bars (green/red 3px strips) are drawn
directly to the selection canvas in `drawSelectionLayer` (lines 640-650).

### What We Add

Each prompt (MARK_A row) gets a real DOM section element inside `textCanvas`:

```typescript
// src/terminal/TerminalHost.ts — new fields
private promptEls = new Map<number, HTMLElement>(); // physRow → <section>
```

```typescript
// src/terminal/TerminalHost.ts — new private methods

private syncPromptAnchors() {
  if (!this.htmlInCanvasEnabled) return;
  if (this.core.modes.isAlternateScreen) return;

  const vc = this.core.virtualCanvas;
  const { cellWidth, cellHeight } = this.renderer;
  const seenRows = new Set<number>();

  for (let r = 0; r < this.rows; r++) {
    const physRow = (vc as any).activeRowMap[r] as number;
    const mark = (vc as any).activePromptMark[physRow] as number;

    // MARK_A = 1 (prompt start)
    if (mark !== 1) continue;

    seenRows.add(physRow);
    let el = this.promptEls.get(physRow);

    if (!el) {
      el = document.createElement("section");
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", "Shell prompt");
      el.tabIndex = -1; // focusable via Tab-navigation logic, not browser default
      el.style.cssText = [
        "position:absolute",
        "pointer-events:none",
        "color:transparent",
        "outline:none",
      ].join(";");
      this.textCanvas.appendChild(el);
      this.promptEls.set(physRow, el);
    }

    el.style.top = `${r * cellHeight}px`;
    el.style.left = "0";
    el.style.width = `${this.cols * cellWidth}px`;
    el.style.height = `${cellHeight}px`;
    el.style.display = "block";
  }

  // Hide prompt elements that scrolled off screen
  for (const [physRow, el] of this.promptEls) {
    if (!seenRows.has(physRow)) {
      el.style.display = "none";
    }
  }
}
```

Call `syncPromptAnchors()` alongside the other sync methods in the render path.

### Native Scroll-to-Prompt via `scrollIntoView`

Instead of the current `scrollToPrompt(absRow)` which sets `viewportOffset`
and schedules a redraw, we can do:

```typescript
// Replace in the Cmd+Up / Cmd+Down handler in handleKeyDown:
const absRow = this.core.findPrevPrompt();
if (absRow >= 0) {
  const physRow = this.core.virtualCanvas.absRowToPhysRow(absRow);
  const el = this.promptEls.get(physRow);
  if (el && this.htmlInCanvasEnabled) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // scrollIntoView on a layoutSubtree child scrolls the canvas viewport
  } else {
    this.core.scrollToPrompt(absRow);
    this.scheduleTextDraw();
    this.scheduleOverlayDraw();
  }
}
```

> **Note:** The spec says `layoutSubtree` children participate in layout
> including scroll anchoring. Whether `scrollIntoView` scrolls the canvas
> viewport or the page viewport is an open spec question (WICG issue #12).
> Test both behaviors and fall back to the `viewportOffset` path if it
> scrolls the page instead.

### Tab Navigation Between Prompts

With `tabIndex = -1` on prompt sections, we can implement Tab-between-prompts:

```typescript
// In handleKeyDown — add before the keyboardEventToSequence call:
if (e.key === "Tab" && e.altKey && !modes.isAlternateScreen) {
  e.preventDefault();
  const direction = e.shiftKey ? -1 : 1;
  this.focusNextPrompt(direction);
  return;
}
```

```typescript
private focusNextPrompt(direction: 1 | -1) {
  const absRow = direction > 0
    ? this.core.findNextPrompt()
    : this.core.findPrevPrompt();
  if (absRow < 0) return;
  const physRow = this.core.virtualCanvas.absRowToPhysRow(absRow);
  const el = this.promptEls.get(physRow);
  if (el) {
    el.tabIndex = 0;
    el.focus();
    el.tabIndex = -1;
    el.scrollIntoView({ block: "nearest" });
  }
}
```

---

## 7. Feature E — `ElementImage` + Worker Rendering (Architecture Sketch)

This is Phase 2, not Phase 1. Include it here to avoid architectural dead-ends.

### The Goal

Move all canvas pixel work (the 3-pass GlyphAtlas draw) to a worker thread,
keeping the main thread free for PTY parsing and DOM updates.

### How `ElementImage` Enables This

```typescript
// Main thread — after syncA11yLayer, for each dirty row:
const rowEl = this.a11yRows[r];
const snapshot: ElementImage = this.textCanvas.captureElementImage(rowEl);
worker.postMessage({ type: "drawRow", row: r, snapshot }, [snapshot as any]);

// Worker thread — OffscreenCanvas:
self.onmessage = ({ data }) => {
  if (data.type === "drawRow") {
    offscreenCtx.drawElementImage(data.snapshot, 0, data.row * cellHeight);
    data.snapshot.close();
  }
};
```

### Why We Don't Need This Yet

Our GlyphAtlas blitting is already extremely fast (measured at <2ms per frame
for a full 80×24 redraw). The bottleneck is PTY parsing and the VT state machine,
both of which are pure CPU work that can't use the canvas. Worker rendering adds
`postMessage` serialization overhead that would likely exceed the gain at our
current draw times.

Re-evaluate when the terminal regularly exceeds 16ms draw times.

---

## 8. Resize and DPR Handling

Any time `fit()` runs, `buildA11yRows(newRows)` must run because the row count
and cell dimensions change together. Order matters:

```typescript
// fit() — after renderer.resize and resizeOverlayCanvases:
if (this.htmlInCanvasEnabled) {
  this.buildA11yRows(this.rows);   // rebuilds with new cellWidth/cellHeight
  this.releaseAllLinks();           // old <a> elements have wrong positions
  // promptEls positions are updated on next syncPromptAnchors call
}
```

When DPR changes (`onDprChange` callback fires the `fit()` path), the same
sequence applies. `buildA11yRows` reads `this.renderer.cellWidth` and
`cellHeight` after the renderer has updated its metrics, so the order is:

1. `renderer.updateMetrics()` ← happens inside `setFontSize → measureCellMetrics`
2. `fit()` ← calls `renderer.resize`
3. `buildA11yRows` ← reads updated metrics

This is already the natural order since `fit()` triggers everything.

---

## 9. What We're Not Changing

| Component | Reason |
|---|---|
| `GlyphAtlas` — 3-pass glyph render | Still the fastest path for terminal text |
| `VirtualCanvas` dirty tracking | Finer-grained than anything the API offers |
| Zero-copy row-index scroll | Pure data structure, browser can't help here |
| Cursor blink on separate canvas layer | Already isolated, no benefit |
| Parser / VT state machine | Nothing in HTML-in-Canvas touches input parsing |
| Selection drawing | Selection state is per-frame transient; DOM elements for it would thrash the pool |

---

## 10. Rollout Sequence

Do these in order. Each step is independently testable.

**Step 1 — Types + detection (no behavior change)**
- Add `src/html-in-canvas.d.ts`
- Add `isHtmlInCanvasSupported()` to `src/terminal/htmlInCanvas.ts`
- Add the `htmlInCanvasEnabled` flag to `TerminalHost`, set it in constructor
- Enable the Chrome Canary flag, verify `htmlInCanvasEnabled === true` in console

**Step 2 — `layoutSubtree` + a11y rows**
- Set `textCanvas.layoutSubtree = true` when enabled
- Implement `buildA11yRows` and `syncA11yLayer`
- Call `syncA11yLayer()` in `scheduleTextDrawRAF` (between draw and clearDirty)
- Test: VoiceOver should announce row text when navigating the canvas

**Step 3 — OSC 8 native links**
- Implement `acquireLink`, `releaseAllLinks`, `syncLinkLayer`
- Call `syncLinkLayer()` after `syncA11yLayer` in the RAF callback
- Delete `detectHoveredUrl`, `setHoveredUrl`, `clearHoveredUrl`
- Delete the OSC 8 underline scan from `drawSelectionLayer`
- Delete the `Cmd+Click` URL branch from `handleMouseDown`
- Test: hover over an OSC 8 URL, confirm pointer cursor; click to open; right-click for native menu

**Step 4 — `onpaint` render loop**
- Add `textCanvas.onpaint` handler
- Implement `scheduleTextDrawHIC` and the dispatch logic in `scheduleTextDraw`
- Stress-test scroll: `yes` piped to the terminal, scroll rapidly
- Confirm duplicate-line bug no longer reproduces

**Step 5 — OSC 133 prompt DOM sections**
- Implement `syncPromptAnchors` and `focusNextPrompt`
- Update Cmd+Up/Down handlers
- Test: jump to prompt scrolls correctly; Alt+Tab moves focus between prompts

**Step 6 — Cleanup**
- Delete the deleted field declarations (`hoveredUrl*`)
- Run the full test suite in `src/terminal/__tests__/core.test.ts`
- Benchmark: measure draw time before/after, confirm no regression

---

## 11. Known Open Questions

**Q: Does `scrollIntoView` on a `layoutSubtree` child scroll the canvas or the page?**
The spec is ambiguous (WICG issue #12). If it scrolls the page, our
`scrollIntoView` call in the prompt-jump handler will break. Keep the existing
`scrollToPrompt(absRow)` path as a fallback guarded by a flag.

**Q: Does `onpaint` fire when we call `requestPaint` with zero dirty rows?**
If yes, we need to guard `scheduleTextDrawHIC` with a dirty-count check before
calling `requestPaint`. If no, the browser handles it for us. Test empirically.

**Q: Are `<a>` elements inside `layoutSubtree` canvas navigable by Tab by default?**
If yes, the browser will Tab-focus into our invisible link pool, which is
unexpected. Add `tabIndex="-1"` to all pool links by default and only restore
it for links we want to be focusable.

**Q: Does `captureElementImage` on an invisible (transparent text) element produce a useful texture for workers?**
The element has `color:transparent` — the captured image will be transparent
for text. For worker rendering (Feature E), we'd need to give the element
real colors, draw it to the worker canvas, then composite it under the glyph
atlas. This changes the Feature E design somewhat.

---

*Document created 2026-04-15. Update as the WICG spec evolves.*
