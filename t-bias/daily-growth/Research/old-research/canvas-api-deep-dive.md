# Canvas API Deep Dive: Building the Fastest Canvas-Rendered Terminal

> Research document for the t-bias terminal emulator project.
> Compiled April 2026.

---

## Table of Contents

1. [Part 1: Canvas API Fundamentals and What Succeeds](#part-1-canvas-api-fundamentals-and-what-succeeds)
2. [Part 2: What Is Difficult and Why](#part-2-what-is-difficult-and-why)
3. [Part 3: Advanced Techniques](#part-3-advanced-techniques)
4. [Part 4: Canvas in Tauri/WebView Context](#part-4-canvas-in-tauriwebview-context)
5. [Appendix: Reference Architectures](#appendix-reference-architectures)

---

## Part 1: Canvas API Fundamentals and What Succeeds

### 1.1 Canvas 2D vs WebGL vs WebGPU -- Tradeoffs for Text-Heavy Applications

The three rendering APIs represent fundamentally different points on the abstraction-vs-performance spectrum:

**Canvas 2D**
- CPU-based immediate-mode rasterization API, backed by Skia (Chrome), CoreGraphics (Safari), or WebRender (Firefox).
- Simplest API surface. `fillText()`, `drawImage()`, `fillRect()` are the core primitives.
- For small-to-medium workloads (< ~10k draw calls/frame), it stays within the 16ms budget on modern hardware. A 50k scatter plot drops Canvas 2D to ~22 FPS.
- GPU-accelerated by default in Chromium since r86510 via Skia's Ganesh backend -- Canvas 2D instructions are translated to GPU commands transparently.
- The single biggest advantage for terminal rendering: `fillText()` uses the platform's native text shaping and rasterization pipeline, giving you correct ligatures, hinting, and subpixel rendering "for free."

**WebGL (WebGL2)**
- Explicit GPU-based rendering. You manage shaders, buffers, textures, and the rendering pipeline directly.
- Text rendering requires building your own glyph atlas (rasterize glyphs to a texture, then draw textured quads). No native `fillText()`.
- Scales dramatically: handles 50k+ elements at 58+ FPS where Canvas 2D falls to 22 FPS.
- xterm.js WebGL renderer: "basically canvas but much lower level and much faster." Builds a `Float32Array` of all cell data, uploads it, and the GPU draws everything in one pass via `drawElementsInstanced`.
- Downside: context loss. Browsers can drop WebGL contexts under memory pressure or system suspend. You must handle `webglcontextlost` events and rebuild state.
- WebGL2 features used by xterm.js: vertex array objects (VAOs), instanced drawing (`drawElementsInstanced`).

**WebGPU**
- As of 2026, WebGPU has reached full cross-browser maturity.
- Eliminates the CPU validation overhead of WebGL. WebGL validates state on every draw call; WebGPU batches command buffers and submits them to the GPU with minimal CPU overhead.
- Compute shaders open new possibilities: Zutty's approach of dispatching one compute invocation per terminal cell can be replicated with WebGPU compute shaders.
- Early benchmarks: Chrome 124 shows WebGPU handling 10M-point scatter arrays at >45 FPS on consumer laptops.
- For a terminal: WebGPU is the long-term optimal path if you want sub-millisecond frame times at 4K resolutions. Beamterm (Rust/WebGL2) already achieves sub-millisecond renders for 45k cells on 2019-era hardware.

**Recommendation for t-bias:** Start with Canvas 2D for correctness and rapid iteration (leveraging native text shaping). Design the renderer interface to be swappable. Implement a WebGL2 fast path once the Canvas 2D renderer is proven, using a glyph atlas approach. WebGPU is the future target for maximum performance.

Sources:
- [SVG vs Canvas vs WebGL Benchmarks](https://www.svggenie.com/blog/svg-vs-canvas-vs-webgl-performance-2025)
- [WebGPU vs WebGL Performance Guide](https://dailydevpost.com/blog/webgpu-vs-webgl-performance-guide)
- [Past and Future of HTML Canvas](https://demyanov.dev/past-and-future-html-canvas-brief-overview-2d-webgl-and-webgpu)
- [xterm.js WebGL Renderer PR #1790](https://github.com/xtermjs/xterm.js/pull/1790)

---

### 1.2 Canvas 2D Text Rendering Internals: fillText, measureText, Font Metrics

#### How fillText() Works Internally

When you call `ctx.fillText(string, x, y)`, the browser:

1. Parses the `ctx.font` CSS font string (family, size, weight, style).
2. Resolves the font to a platform font handle (via the OS font system).
3. Performs text shaping (on platforms that support it, this involves HarfBuzz or the OS shaper).
4. Rasterizes glyphs using the platform rasterizer (FreeType on Linux, CoreText on macOS, DirectWrite on Windows -- or Skia's own rasterizer in Chrome).
5. Composites the rasterized glyphs onto the canvas bitmap at the specified coordinates, applying the current `fillStyle`, `globalAlpha`, `textBaseline`, `textAlign`, and any active transforms.

This is an **expensive operation**. Each `fillText()` call potentially involves font resolution, shaping, rasterization, and compositing. Chrome's profiling shows fillText at 6-8ms per frame for moderate workloads, while Firefox can take 42-47ms for the same content.

#### measureText() and TextMetrics

`ctx.measureText(string)` returns a `TextMetrics` object. The modern TextMetrics API provides:

```
TextMetrics {
  width                    // Advance width (for text placement)
  actualBoundingBoxLeft    // Distance from textAlign to left edge of bounding box
  actualBoundingBoxRight   // Distance from textAlign to right edge of bounding box
  fontBoundingBoxAscent    // Distance from textBaseline to top of font em-box
  fontBoundingBoxDescent   // Distance from textBaseline to bottom of font em-box
  actualBoundingBoxAscent  // Distance from textBaseline to top of actual glyph ink
  actualBoundingBoxDescent // Distance from textBaseline to bottom of actual glyph ink
  emHeightAscent           // Distance from textBaseline to top of em square
  emHeightDescent          // Distance from textBaseline to bottom of em square
  hangingBaseline          // Distance from textBaseline to hanging baseline
  alphabeticBaseline       // Distance from textBaseline to alphabetic baseline
  ideographicBaseline      // Distance from textBaseline to ideographic baseline
}
```

**Critical insight for terminal rendering:** For monospace cell sizing, the most reliable approach is:
- Cell width: `ctx.measureText('W').width` (or measure a representative character).
- Cell height: `fontBoundingBoxAscent + fontBoundingBoxDescent` gives the full font height. For actual ink height: `actualBoundingBoxAscent + actualBoundingBoxDescent`.
- Use `actualBoundingBoxLeft + actualBoundingBoxRight` for accurate horizontal bounds (some glyphs extend beyond their advance width).

**Warning:** `fontBoundingBoxAscent/Descent` can differ by ~21px between Chrome and Safari for the same font. See Section 2.2 for details.

Sources:
- [Understanding Canvas Text Metrics](https://erikonarheim.com/posts/canvas-text-metrics/)
- [TextMetrics MDN](https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics)
- [Canvas text rendering interop issue #427](https://github.com/web-platform-tests/interop/issues/427)
- [Measuring line height with Canvas](https://loga.nz/blog/measuring-line-height/)

---

### 1.3 High-Performance Canvas 2D Rendering Patterns

#### Pre-rendering / Offscreen Canvas Caching

The single most impactful optimization for Canvas 2D text rendering:

1. Render each unique glyph+style combination once to an offscreen canvas.
2. Use `drawImage()` to stamp the cached glyph bitmap to the visible canvas.

Benchmark data: rendering drops from **10ms to 1ms per frame** in Firefox when switching from direct `fillText()` to cached `drawImage()`. This is a 10x improvement.

For a terminal with ~200 visible columns x ~50 rows = 10,000 cells, calling `fillText()` 10,000 times per frame is infeasible. Caching glyphs reduces this to 10,000 `drawImage()` calls, which is dramatically faster since `drawImage()` is essentially a texture blit.

#### Minimize State Changes

Group draw calls by style. The Canvas 2D state machine is expensive to change:
- Changing `ctx.font` triggers font resolution (very expensive).
- Changing `ctx.fillStyle` requires flushing the GPU pipeline.
- `save()`/`restore()` pushes/pops the entire state stack.

For terminal rendering, sort cells by foreground color and draw all cells of the same color in one batch.

#### Batch Path Operations

Use `Path2D` objects for repeated shapes. Define once, draw many times. For terminal backgrounds, a single `fillRect()` per contiguous run of same-background cells is better than per-cell rectangles.

#### Avoid Expensive Properties

- `shadowBlur`: massive performance hit; avoid entirely.
- `globalCompositeOperation`: changing this can force pipeline flushes.
- Complex transforms: each transform change can invalidate GPU caching.

#### Integer Coordinates

Round all coordinates to integers to avoid subpixel rendering overhead. The browser must perform anti-aliasing for non-integer positions:

```javascript
// BAD: triggers subpixel anti-aliasing
ctx.fillText('A', 10.5, 20.3);

// GOOD: clean pixel boundaries
ctx.fillText('A', Math.round(10.5), Math.round(20.3));
```

Sources:
- [MDN: Optimizing Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
- [web.dev: Canvas Performance](https://web.dev/articles/canvas-performance)
- [AG Grid: Canvas Rendering Best Practices](https://blog.ag-grid.com/optimising-html5-canvas-rendering-best-practices-and-techniques/)
- [Supercharging Canvas fillText](https://www.mirkosertic.de/blog/2015/03/tuning-html5-canvas-filltext/)

---

### 1.4 OffscreenCanvas and Its Benefits for Terminal Rendering

`OffscreenCanvas` provides a canvas that can be rendered off-screen and optionally in a Web Worker, decoupling rendering from the DOM and the main thread.

#### Two Usage Patterns

**Pattern 1: Synchronous offscreen (same thread)**
```javascript
const offscreen = new OffscreenCanvas(width, height);
const offCtx = offscreen.getContext('2d');
offCtx.fillText('A', 0, 0);
// Use as image source:
mainCtx.drawImage(offscreen, x, y);
```
This is the glyph caching pattern. No DOM dependency, slightly faster than a hidden `<canvas>` element because there is no DOM synchronization.

**Pattern 2: Worker-based rendering**
```javascript
// Main thread:
const canvas = document.querySelector('canvas');
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);

// Worker:
onmessage = (e) => {
  const ctx = e.data.canvas.getContext('2d');
  // All rendering happens here, off main thread
};
```
Operations applied to the `OffscreenCanvas` in the worker are rendered on the source canvas automatically. The main thread stays free for input handling, IPC with Tauri/Rust, and other UI tasks.

#### Benefits for Terminal Rendering

1. **Main thread freedom**: Terminal input processing, PTY communication (via Tauri commands), and UI events never compete with rendering for CPU time.
2. **No jank from heavy redraws**: A full screen redraw (e.g., after `clear` or `cat large_file.txt`) can take multiple milliseconds. In a worker, this doesn't block the main thread.
3. **Parallel glyph rasterization**: Multiple `OffscreenCanvas` instances can rasterize different parts of the glyph atlas concurrently.

#### Browser Support (2026)

OffscreenCanvas is supported in all major browsers. The `transferControlToOffscreen()` method is the key API for worker-based rendering.

Sources:
- [web.dev: OffscreenCanvas](https://web.dev/articles/offscreen-canvas)
- [MDN: OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [Samsung Internet: OffscreenCanvas Workers and Performance](https://medium.com/samsung-internet-dev/offscreencanvas-workers-and-performance-3023ca15d7c7)

---

### 1.5 The Canvas 2D Rendering Pipeline in Browsers

Understanding the full pipeline helps identify where bottlenecks occur:

#### Chrome (Blink + Skia)

```
JavaScript Canvas API calls
    |
    v
CanvasRenderingContext2D (Blink)
    |
    v
Skia SkCanvas (records drawing operations as SkPicture)
    |
    v
Rasterization (two paths):
  a) Software rasterizer -> bitmap -> upload to GPU as texture
  b) Ganesh (Skia GPU backend) -> GL commands -> GPU process via command buffer
    |
    v
Compositor thread: tiles + layers -> frame
    |
    v
Display
```

**Key detail:** Canvas 2D has been GPU-accelerated in Chrome since ~2011 via Ganesh. As of 2025-2026, Chrome is transitioning from Ganesh to **Graphite**, a new GPU rasterization backend. Graphite uses two Recorders: one for web content tiles and Canvas2D on the main thread, another for compositing.

**Tiling:** The compositor breaks layers into tiles. Tiles near the viewport are prioritized. GPU memory is allocated to tiles by priority. This means offscreen canvas content may be deprioritized.

#### Safari (WebKit + CoreGraphics/CoreAnimation)

Safari uses CoreGraphics for 2D rendering and Core Animation (CALayer) for compositing. The rendering is tied more closely to the OS graphics stack. This means Canvas 2D text rendering on Safari uses CoreText for font shaping, which can produce different metrics than Chrome's Skia-based text.

#### Firefox (Gecko + WebRender)

Firefox's WebRender sends the display list directly to the GPU, making rasterization and compositing fully GPU-driven. WebRender draws vectors on GPU directly rather than creating intermediate bitmaps. This means Firefox can potentially animate more content at high performance because it doesn't need to re-rasterize layers when small portions change.

**Premultiplied alpha:** All three browsers use premultiplied alpha for compositing. Color values are pre-multiplied by alpha (composited on black). This is relevant if you're doing manual pixel manipulation via `getImageData`/`putImageData` -- you'll see premultiplied values.

Sources:
- [Chromium: Graphics and Skia](https://www.chromium.org/developers/design-documents/graphics-and-skia/)
- [Chromium: GPU Accelerated Compositing](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)
- [Introducing Skia Graphite](https://22.frenchintelligence.org/2025/07/08/introducing-skia-graphite-chromes-rasterization-backend-for-the-future/)
- [Chrome: Taking advantage of GPU acceleration in 2D canvas](https://developer.chrome.com/blog/taking-advantage-of-gpu-acceleration-in-the-2d-canvas)

---

### 1.6 Text Atlases and Glyph Caching on Canvas

A **glyph atlas** (or texture atlas) is the core technique used by every high-performance terminal renderer (xterm.js, Warp, Kitty, Ghostty, Windows Terminal, Alacritty).

#### How It Works

1. **Rasterize on demand:** When a glyph+style combination is first needed, render it to an offscreen canvas using `fillText()`.
2. **Store in atlas:** Copy the rendered glyph into a larger atlas canvas/texture. Track its position (x, y, width, height) in a lookup map.
3. **Render from atlas:** To draw a cell, use `drawImage(atlas, sx, sy, sw, sh, dx, dy, dw, dh)` to stamp the cached glyph.

#### Atlas Key

The cache key must encode everything that affects glyph appearance:
- Character codepoint (or grapheme cluster)
- Font family + size + weight + style
- Foreground color
- Background color (if pre-composited)
- Bold / italic / underline / strikethrough flags

xterm.js notes: "Due to the number of styles possible in a terminal (16 million foreground x 16 million background x possible unicode characters), the atlas must be dynamic."

#### Atlas Sizing and Packing

xterm.js evolution:
- **v4.x:** Single 1024x1024 atlas; clears and restarts when full.
- **v5.1+:** Multiple atlas pages, each 512x512, continually merging up to 4096x4096. New packing strategy uses multiple active rows, placing glyphs in the most suitable row by pixel height. This dramatically reduces wasted atlas space.

**Separate atlases for colored glyphs:** Emoji and color fonts go in a separate RGBA atlas. Standard text uses a grayscale atlas (single channel), saving memory and allowing different blending modes.

#### Performance Impact

xterm.js: Using the texture atlas with `ImageBitmap` (co-located on GPU) improved drawing speed "considerably" over raw `fillText()` calls. Single character changes went from ~6ms to < 0.25ms.

Warp terminal: average screen redraw time of **1.9ms** using Metal + glyph atlas, capable of >144 FPS on 4K.

Sources:
- [Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [Contour Terminal: Text Stack](https://contour-terminal.org/internals/text-stack/)
- [Microsoft Terminal: AtlasEngine PR #11623](https://github.com/microsoft/terminal/pull/11623)
- [xterm.js: Consolidate texture atlas #4065](https://github.com/xtermjs/xterm.js/issues/4065)
- [xterm.js 5.1.0 Release Notes](https://github.com/xtermjs/xterm.js/releases/tag/5.1.0)

---

### 1.7 requestAnimationFrame Best Practices

#### Core Rules for Terminal Rendering

1. **Always use rAF, never setInterval/setTimeout for rendering.** rAF synchronizes with the display's v-sync, preventing tearing and wasted frames.

2. **Use the timestamp parameter for frame-rate independence:**
```javascript
function render(timestamp) {
  const delta = timestamp - lastTimestamp;
  lastTimestamp = timestamp;
  // Use delta to throttle updates if needed
  requestAnimationFrame(render);
}
```

3. **Budget: 16.67ms at 60Hz, 8.33ms at 120Hz.** Everything -- JS execution, style calculation, layout, paint, composite -- must fit within this budget. For a terminal renderer with no DOM layout, most of this budget is available for rendering.

4. **Debounce terminal updates.** When receiving rapid PTY output (e.g., `cat /dev/urandom`), don't render every incoming chunk. Buffer updates and render at most once per rAF callback. xterm.js uses a `RenderService` that debounces updates.

5. **Skip frames when behind.** If rendering takes longer than the frame budget, don't try to catch up. Drop frames gracefully and render the latest state.

6. **On high-refresh displays (120Hz/144Hz):** The frame budget shrinks. Consider whether every frame actually needs a full redraw. A terminal that only updates when content changes can skip many frames entirely.

#### Terminal-Specific Pattern

```javascript
let dirty = false;
let pendingFrame = null;

function markDirty() {
  dirty = true;
  if (!pendingFrame) {
    pendingFrame = requestAnimationFrame(renderFrame);
  }
}

function renderFrame(timestamp) {
  pendingFrame = null;
  if (dirty) {
    dirty = false;
    performRender();
  }
}
```

This ensures rendering only happens when content has changed, and at most once per v-sync interval.

Sources:
- [MDN: requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- [web.dev: Jank Busting for Better Rendering Performance](https://web.dev/articles/speed-rendering)
- [Performant Game Loops in JavaScript](https://www.aleksandrhovhannisyan.com/blog/javascript-game-loop/)

---

### 1.8 Device Pixel Ratio and High-DPI Rendering

#### The Problem

Canvas elements have a **backing store** (actual pixel dimensions) and a **CSS size** (displayed dimensions). On a 2x DPI display, a canvas with CSS size 800x600 only has 800x600 backing pixels by default, causing blurry rendering when the browser scales it up.

#### The Solution

```javascript
const dpr = window.devicePixelRatio || 1;
const canvas = document.querySelector('canvas');

// Set backing store to physical pixels
canvas.width = cssWidth * dpr;
canvas.height = cssHeight * dpr;

// Set CSS size to logical pixels
canvas.style.width = cssWidth + 'px';
canvas.style.height = cssHeight + 'px';

// Scale all drawing operations
const ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);
```

#### Terminal-Specific Considerations

- **Cell sizing must account for DPR.** A 10px font at 2x DPR is actually 20 physical pixels. The glyph atlas should rasterize at the physical resolution for sharp text.
- **Memory doubles (or more) with DPR.** A 1920x1080 canvas at 2x DPR requires a 3840x2160 backing store = ~33MB (RGBA).
- **Font metrics may not scale linearly.** Hinting and pixel-rounding can cause metrics to differ at different DPR values. Measure at the actual rendering DPR.
- **Watch for DPR changes.** When a window moves between displays with different DPR, you need to resize the canvas and re-rasterize the glyph atlas. Use `matchMedia('(resolution: Xdppx)')` to detect changes.

Common DPR values:
- Standard displays: 1.0
- Retina/HiDPI: 2.0
- Modern mobile: 2.0-3.0
- Some Windows laptops: 1.25, 1.5, 1.75 (fractional scaling)

Fractional DPR (e.g., 1.5) is the hardest case -- no integer pixel alignment, so subpixel blending artifacts are inevitable.

Sources:
- [Kirupa: Canvas High DPI Retina](https://www.kirupa.com/canvas/canvas_high_dpi_retina.htm)
- [MDN: devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)
- [High DPI rendering on HTML5 Canvas](https://cmdcolin.github.io/posts/2014-05-22/)
- [How to Fix Blurry Text on HTML Canvases](https://dev.to/pahund/how-to-fix-blurry-text-on-html-canvases-on-mobile-phones-3iep)

---

### 1.9 Dirty-Region / Partial Redraw Patterns

Full-screen redraws are wasteful for a terminal where typically only a few cells change per frame (cursor blink, new output line, etc.).

#### Strategy

1. **Track dirty cells.** Maintain a grid-sized boolean (or bitmask) array. Mark cells dirty when their content, attributes, or colors change.
2. **Compute dirty regions.** Optionally coalesce adjacent dirty cells into rectangular regions to reduce the number of `clearRect` + redraw operations.
3. **Clear only dirty regions.** Use `ctx.clearRect(x, y, w, h)` only on the changed areas.
4. **Redraw only dirty cells.** Draw glyphs (from the atlas) only for cells that changed.
5. **Reset dirty flags.** After rendering, clear all dirty flags.

#### xterm.js Approach

xterm.js keeps a "slim internal model containing minimal information about a cell's drawn state." Before drawing a cell, it diffs the new state against the drawn state. If identical, the draw is skipped. Result: single character changes take < 0.25ms.

#### Threshold Mechanism

When many objects change simultaneously (e.g., full screen scroll), dirty-region tracking becomes overhead rather than optimization. Some engines (like Cocos2D) automatically switch from dirty-region mode to full-redraw mode when the dirty count exceeds a threshold.

For a terminal, a reasonable threshold: if more than ~50% of visible cells are dirty, do a full redraw. Typical terminal operations (typing, small output) dirty < 5% of cells.

Sources:
- [MDN: Optimizing Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
- [AG Grid: Canvas Rendering Optimization](https://blog.ag-grid.com/optimising-html5-canvas-rendering-best-practices-and-techniques/)
- [Cocos Creator: Dirty Region Optimization](https://joyhooei.gitbooks.io/cocos-creator-docs/content/en/advanced-topics/dirty-region.html)

---

### 1.10 Canvas Compositing and Layer Management

#### Multiple Canvas Layers

The proven approach (used by xterm.js) is to stack multiple `<canvas>` elements using CSS `position: absolute` and `z-index`:

```
[Bottom]  TextRenderLayer      - background colors + glyph rendering
          SelectionRenderLayer - selection highlight overlay
          LinkRenderLayer      - hyperlink underlines/colors
[Top]     CursorRenderLayer    - cursor block/beam/underline + blink animation
```

Each layer has its own canvas and context. Only the layer that changed needs to redraw.

#### Benefits

- **Isolation:** Cursor blink animation (every ~500ms) only redraws the tiny cursor canvas, not the entire text layer.
- **Selection:** Drawing a selection highlight doesn't require redrawing all text glyphs.
- **Simplicity:** Each render layer's logic is self-contained and testable.

#### Limits

- 3-5 canvas layers maximum. Each canvas consumes GPU memory (width x height x 4 bytes x DPR^2). The browser compositor must composite all layers every frame.
- The browser's GPU compositor handles the layer compositing for free (it's what it does for DOM elements anyway), so the overhead is minimal for a small number of layers.

#### Canvas 2D Compositing Operations

`globalCompositeOperation` controls how new drawing operations combine with existing content. Default is `source-over` (standard alpha blending). For selection rendering, `multiply` or a semi-transparent `fillRect` over the selected region works well. Avoid changing `globalCompositeOperation` frequently -- it can force pipeline flushes.

Sources:
- [Using Multiple HTML5 Canvases as Layers](https://html5.litten.com/using-multiple-html5-canvases-as-layers/)
- [Konva: Layer Management Performance](https://konvajs.org/docs/performance/Layer_Management.html)
- [VS Code Terminal Performance Blog](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)

---

## Part 2: What Is Difficult and Why

### 2.1 Why Canvas Text Rendering Is Slow

`fillText()` is the most expensive single operation in Canvas 2D for terminal rendering. The specific bottlenecks:

1. **Font resolution:** Every `fillText()` call must resolve the CSS font string to a platform font handle. If you change `ctx.font`, this triggers a full font parse + match. Even with caching, the per-call overhead is non-trivial.

2. **Text shaping:** For complex scripts, the browser invokes the platform text shaper (HarfBuzz, CoreText, DirectWrite). Even for simple Latin text, basic shaping is required to handle kerning and ligatures.

3. **Glyph rasterization:** Each glyph must be rasterized to a bitmap. The platform rasterizer (FreeType, CoreText, etc.) performs hinting, anti-aliasing, and subpixel rendering. This is compute-intensive.

4. **GPU synchronization:** In GPU-accelerated Canvas 2D, each text draw may require uploading glyph bitmaps to GPU textures, which involves CPU-GPU synchronization.

**Benchmark data:**
- Chrome `fillText`: 6-8ms per frame (moderate workload)
- Firefox `fillText`: 42-47ms per frame (same workload) -- ~6x slower than Chrome
- With offscreen canvas caching: **1ms per frame** (10x improvement over uncached)

**The fundamental insight:** `fillText()` is designed for occasional text rendering (labels, annotations), not for rendering thousands of glyphs per frame. For a terminal, you must cache glyph bitmaps and use `drawImage()` instead.

Sources:
- [Mirko Sertic: Supercharging Canvas fillText](https://www.mirkosertic.de/blog/2015/03/tuning-html5-canvas-filltext/)
- [Mozilla Bug: Canvas text functions too slow](https://bugzilla.mozilla.org/show_bug.cgi?id=527386)
- [canvas-fill-text-opt benchmarks](https://github.com/debevv/canvas-fill-text-opt)

---

### 2.2 Font Metrics Accuracy Challenges

This is one of the hardest problems for a Canvas-based terminal.

#### Cross-Browser Inconsistency

`TextMetrics` values vary significantly between browsers:
- `fontBoundingBoxAscent/Descent` can differ by **~21px** between Chrome and Safari for the same font.
- `textBaseline="top"` renders differently in Firefox vs other browsers.
- Some fonts have bugs in their metrics tables (e.g., Arial Black has an incorrectly signed descender field).

This was a Interop 2024 focus area (issue #427), with some improvements, but full consistency is not achieved.

#### Implications for Terminal Cell Sizing

A monospace terminal requires:
- Perfectly uniform cell width: every character must occupy exactly the same horizontal space.
- Perfectly uniform cell height: every row must have exactly the same vertical spacing.
- Consistent baseline alignment across all characters in a row.

If `measureText()` returns slightly different widths for different characters in the "same" monospace font, columns won't align. This happens more often than you'd expect with Unicode characters, CJK wide characters, and emoji.

#### Practical Solutions

1. **Measure a single representative character** (e.g., 'W' or 'M') and use that for all cells. Don't measure each character individually.
2. **Force clip to cell boundaries.** Even if a glyph overflows its cell, clip it. Visual imperfection is better than broken grid alignment.
3. **Use `fontBoundingBox*` for cell height**, not `actualBoundingBox*`. The font bounding box is the maximum extent; actual bounding box varies per character.
4. **Measure at render DPR.** Font metrics can change with DPR due to hinting. Measure once at the actual rendering resolution and cache.
5. **Wait for font loading.** Canvas doesn't automatically update when fonts load. Use the Font Loading API (`document.fonts.ready`) before measuring.

Sources:
- [Canvas text rendering interop issue](https://github.com/web-platform-tests/interop/issues/427)
- [Understanding Canvas Text Metrics](https://erikonarheim.com/posts/canvas-text-metrics/)
- [Firefox bug: TextBaseline top looks different](https://bugzilla.mozilla.org/show_bug.cgi?id=737852)

---

### 2.3 Subpixel Antialiasing on Canvas

#### The Problem

Subpixel antialiasing (ClearType on Windows, subpixel rendering on macOS) exploits the RGB subpixel layout of LCD displays to achieve effective resolution 3x the pixel grid for horizontal edges. This makes text dramatically sharper.

However, Canvas 2D largely cannot use subpixel antialiasing because:

1. **Canvas content is composited as a single layer.** Subpixel antialiasing requires knowing the background color at render time (the RGB channel contributions depend on what's behind the text). Canvas content may be composited over arbitrary backgrounds.

2. **Transparent backgrounds break subpixel rendering.** If the canvas has any transparency, subpixel AA produces color fringe artifacts.

3. **Browser control is limited.** There is no API to request subpixel AA on Canvas. The `textRendering` property offers `auto`, `optimizeSpeed`, `optimizeLegibility`, and `geometricPrecision`, but none guarantee subpixel AA.

#### What Browsers Actually Do

- **Chrome:** Uses grayscale antialiasing for Canvas text by default. No subpixel AA.
- **Safari:** May use subpixel AA in some cases when the canvas is opaque and hardware conditions are met.
- **Firefox:** Generally uses grayscale AA for Canvas.

#### Terminal Implication

Since terminal backgrounds are typically opaque and known at render time, you can work around this:
- Pre-composite text onto the known background color in the glyph atlas. This allows the atlas rasterization to use subpixel AA (if the platform supports it).
- Each glyph atlas entry becomes foreground+background specific, increasing atlas size but enabling sharper text.

xterm.js does this: the texture atlas contains glyphs rendered on their actual background color for the most common styles.

Sources:
- [Canvas rendering: Hinting and subpixel antialiasing](https://github.com/opentypejs/opentype.js/issues/345)
- [Chrome subpixel rendering in Canvas](https://copyprogramming.com/howto/sub-pixel-rendering-in-chrome-canvas)
- [Canvas font rendering results comparison](https://www.laurencegellert.com/2013/04/html5-canvas-font-rendering-results/)

---

### 2.4 Canvas State Management Gotchas

#### Performance Cost of save()/restore()

Each `save()` pushes the entire context state (transforms, clip region, fill/stroke styles, font, shadow settings, compositing mode, etc.) onto a stack. Each `restore()` pops it.

For terminal rendering with 10,000+ cells per frame, naive per-cell `save()`/`restore()` adds measurable overhead.

**Best practice:** Minimize state changes. Group draws by style:

```javascript
// BAD: 10,000 save/restore pairs
for (const cell of cells) {
  ctx.save();
  ctx.fillStyle = cell.fg;
  ctx.fillRect(cell.x, cell.y, cellW, cellH);
  ctx.restore();
}

// GOOD: Group by color, no save/restore needed
const cellsByColor = groupBy(cells, c => c.fg);
for (const [color, group] of cellsByColor) {
  ctx.fillStyle = color;
  for (const cell of group) {
    ctx.fillRect(cell.x, cell.y, cellW, cellH);
  }
}
```

#### Font Property Is Expensive

Setting `ctx.font` triggers CSS font string parsing. If you set the same font string repeatedly, browsers may cache the parse result, but it's still a string comparison. For terminal rendering, set `ctx.font` once per style change, not per cell.

#### Transform Accumulation

Transforms are cumulative. `ctx.translate(10, 0)` followed by `ctx.translate(5, 0)` results in a total offset of 15. Without `save()`/`restore()`, transforms accumulate across calls. For terminal cell positioning, prefer passing absolute coordinates to `drawImage()` / `fillText()` rather than using translate.

Sources:
- [MDN: save()](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/save)
- [Canvas Performance Tips](https://gist.github.com/jaredwilli/5469626)

---

### 2.5 Canvas Color Management

#### The Default: sRGB

Canvas 2D operates in sRGB by default. All CSS color values, `fillStyle`, and pixel data are interpreted as sRGB with 8 bits per channel.

#### Wide Gamut: Display P3

Since Safari 16+ and Chrome 94+, you can create a canvas in the Display P3 color space:

```javascript
const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
ctx.fillStyle = 'color(display-p3 1 0.5 0)'; // P3 color
```

P3 is ~25% larger gamut than sRGB, enabling more vivid colors.

#### Terminal Implications

- Most terminal color schemes use sRGB. Wide gamut is rarely needed.
- However, if you're doing image rendering (sixel, iTerm2 protocol), wide gamut support could matter for photo-accurate inline images.
- **The gotcha:** Color space conversion between sRGB and P3 is lossy. If your terminal theme uses sRGB colors but the canvas is in P3, the colors may shift slightly.
- `getImageData()` / `putImageData()` pixel values depend on the canvas color space. Code that assumes sRGB will produce wrong results on a P3 canvas.

Sources:
- [WebKit: Wide Gamut 2D Graphics](https://webkit.org/blog/12058/wide-gamut-2d-graphics-using-html-canvas/)
- [Canvas Color Space Proposal](https://github.com/WICG/canvas-color-space/blob/main/CanvasColorSpaceProposal.md)
- [Chrome Canvas Color Management Status](https://chromestatus.com/feature/5807007661555712)

---

### 2.6 Memory Issues with Large Canvas Surfaces

#### Memory Formula

```
Memory = width * height * 4 bytes (RGBA) * DPR^2
```

Examples at DPR 2.0:
- 1920x1080 terminal: 3840x2160 backing = **33.2 MB**
- 2560x1440 terminal: 5120x2880 backing = **59.0 MB**
- 3840x2160 (4K): 7680x4320 backing = **132.7 MB**

**Each additional canvas layer** (text, selection, cursor, links) multiplies this. Four layers at 4K DPR 2.0 = **530 MB** just for canvas backing stores.

#### Browser Limits

- **iOS Safari:** 384 MB total canvas memory limit. Only ~46 standard 2D canvases or 4-9 WebGL canvases at 1920x1080.
- **WebGL contexts:** Consume 5-10x more memory than 2D contexts due to multiple internal buffers (drawing buffer, back buffer, GPU state). A single WebGL 1920x1080 canvas uses 40-80 MB.
- **Firefox:** GPU acceleration of canvas has been reported to cause memory leaks that can rapidly crash the browser.

#### Mitigation Strategies

1. **Minimize canvas count.** Use the fewest layers possible. Consider rendering selection/cursor on the same canvas as text.
2. **Size canvases to viewport only.** Don't create a canvas larger than the visible terminal area. Scrollback is not rendered on canvas; it's reconstructed on demand when scrolling.
3. **Release unused canvases.** Set canvas width/height to 0 to release backing store memory. Or call the new `ctx.reset()` method.
4. **Monitor with `ctx.isContextLost()`.** The new Canvas 2D `contextlost` event fires when the browser reclaims resources. Handle it by rebuilding state.

Sources:
- [Mozilla Bug: Support very large canvases](https://bugzilla.mozilla.org/show_bug.cgi?id=1282074)
- [WebKit Bug: Canvas memory limit 256MB](https://bugs.webkit.org/show_bug.cgi?id=195325)
- [Mozilla Bug: GPU acceleration memory leak](https://bugzilla.mozilla.org/show_bug.cgi?id=1697344)

---

### 2.7 Canvas and the Browser Compositor

#### How They Interact

The canvas element is a compositing layer in the browser's layer tree. The compositor thread:
1. Takes the canvas's GPU texture (rasterized content).
2. Composites it with other layers (DOM elements above/below).
3. Outputs the final frame.

For a terminal that is the only visible content (typical for t-bias), this is optimal -- the compositor has minimal work. But if you overlay DOM elements (scrollbars, status bar, menus), each DOM element is a separate compositing layer, and the compositor must blend them.

#### Problems

- **Canvas invalidation:** Any `drawImage()`, `fillText()`, etc. call marks the canvas as needing re-upload to the GPU compositor. Even drawing a single pixel invalidates the entire canvas texture.
- **Synchronization:** The canvas is rasterized on the main thread (unless using OffscreenCanvas in a worker), but compositing happens on the compositor thread. There's an implicit synchronization point at frame boundaries.
- **Forced compositing:** CSS properties like `transform`, `opacity`, `will-change` can force the canvas into its own compositing layer, which is usually what you want for performance (avoids re-rasterizing other layers).

#### Optimization

Apply `will-change: transform` to your canvas elements to hint to the browser that they should be on their own compositor layers. This prevents other DOM changes from triggering canvas re-rasterization.

---

### 2.8 Canvas Accessibility Challenges

**Canvas content is invisible to screen readers.** The rendered pixels have no semantic meaning. This is a fundamental limitation.

#### Approaches for Terminal Accessibility

1. **Hidden DOM mirror:** Maintain a hidden DOM structure that mirrors the terminal content. Update it in sync with canvas rendering. Screen readers read the DOM; sighted users see the canvas. This is expensive but provides the best accessibility.

2. **ARIA labeling:** Set `role="img"` and `aria-label` on the canvas element with a text summary. This is minimal but inadequate for a full terminal.

3. **Fallback content:** Place text content between `<canvas>` and `</canvas>` tags. Only visible when canvas is not supported, but screen readers can access it.

4. **Live regions:** Use `aria-live="polite"` on a hidden element that receives new terminal output lines. Screen readers announce new content as it appears.

For t-bias, option 1 (hidden DOM mirror) combined with option 4 (live regions for new output) provides the most complete solution.

Sources:
- [HTML Canvas Accessibility Demo](https://pauljadam.com/demos/canvas.html)
- [W3C Canvas Accessibility](https://www.w3.org/WAI/tutorials/)

---

### 2.9 Selection and Copy/Paste on Canvas

**This is one of the hardest UI problems for canvas-rendered terminals.**

The browser's native text selection doesn't work on canvas content because there is no selectable text in the DOM.

#### Implementation Strategy (proven by xterm.js)

1. **Custom selection logic:** Track mouse down/move/up events. Map pixel coordinates to cell grid positions. Maintain selection start/end as cell coordinates.

2. **Selection rendering:** Draw a semi-transparent rectangle over selected cells on the SelectionRenderLayer canvas.

3. **Hidden textarea for clipboard:** Maintain an invisible `<textarea>` element. When the user copies (Cmd+C):
   - Extract the text content from the terminal buffer for the selected cell range.
   - Write it to the hidden textarea.
   - Programmatically select the textarea content.
   - Let the browser's native copy command work on the textarea.

4. **Paste:** Listen for paste events on the hidden textarea. Forward pasted text to the PTY.

This hidden textarea approach is the standard pattern used by all canvas-based text editors and terminals (xterm.js, Monaco editor, etc.).

#### Challenges

- Double-click word selection, triple-click line selection, Shift+click extend selection must all be manually implemented.
- Selection across line wraps requires understanding the terminal buffer's line structure.
- Right-to-left text and mixed bidirectional content complicate selection geometry.

Sources:
- [VS Code Terminal Performance Blog](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)
- [Canvas text editor tutorial](https://github.com/grassator/canvas-text-editor-tutorial)

---

### 2.10 Performance Cliffs in Canvas 2D

Canvas 2D performance degrades predictably in these scenarios:

1. **Too many draw calls per frame.** Each Canvas API call (fillRect, drawImage, fillText) is an individual command. At O(n) per frame, with each call taking microseconds, you hit the 16ms budget at ~10,000-50,000 calls depending on complexity. There is no batching API for Canvas 2D (unlike WebGL's instanced drawing).

2. **Frequent style changes.** Each change to `fillStyle`, `font`, `strokeStyle`, etc. may flush the internal GPU command queue. Sort draws by style to minimize changes.

3. **Large canvas + `getImageData()`/`putImageData()`.** Reading pixels back from a GPU-accelerated canvas triggers a GPU-to-CPU readback, which is one of the slowest operations possible. Avoid `getImageData()` in the render loop.

4. **`willReadFrequently` trap.** Setting this to `true` disables GPU acceleration entirely. Reads become faster (~3ms to ~1ms) but writes become dramatically slower (~35ms+ penalty).

5. **Shadow effects.** `shadowBlur`, `shadowColor` trigger expensive multi-pass rendering. Never use these in a terminal renderer.

6. **Complex clip regions.** Non-rectangular clip paths require expensive pixel-level clipping.

7. **Compositing mode changes.** Switching `globalCompositeOperation` mid-frame forces pipeline flushes.

8. **WebView2 regression (2025).** WebView2 Runtime 142 introduced a severe performance regression for canvas at 4K+ resolution: FPS dropped from ~160 to ~50 for stacked canvas layers.

Sources:
- [Why is Canvas 2D so slow? (WICG discussion)](https://discourse.wicg.io/t/why-is-canvas-2d-so-slow/2232/)
- [Chrome: willReadFrequently explained](https://www.schiener.io/2024-08-02/canvas-willreadfrequently)
- [Chrome Canvas2D blog post](https://developer.chrome.com/blog/canvas2d)
- [WebView2 canvas performance bug #5426](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5426)

---

### 2.11 Browser Implementation Differences

| Aspect | Chrome (Blink/Skia) | Safari (WebKit/CoreGraphics) | Firefox (Gecko/WebRender) |
|---|---|---|---|
| **2D Rasterizer** | Skia (Ganesh/Graphite GPU backends) | CoreGraphics (CPU) + Metal compositing | WebRender (GPU vector rendering) |
| **Text Shaping** | Skia + HarfBuzz | CoreText | HarfBuzz |
| **GPU Acceleration** | On by default (Canvas 2D) | Selective/implicit | WebRender is all-GPU |
| **fillText Speed** | 6-8ms (moderate load) | Varies | 42-47ms (same load, historically) |
| **TextMetrics Accuracy** | Good (Interop focus) | Can differ by ~21px in fontBoundingBox | Different textBaseline behavior |
| **Subpixel AA** | Grayscale only on Canvas | May use subpixel on opaque canvas | Grayscale on Canvas |
| **OffscreenCanvas** | Full support | Full support | Full support |
| **WebGL2** | Full support | Full support (since Safari 15) | Full support |
| **WebGPU** | Full support (2026) | Full support (2026) | Full support (2026) |

**Key takeaway:** Design your renderer to be resilient to metric differences. Measure fonts at runtime on the actual browser, don't hardcode pixel values. Test on all three engines.

Sources:
- [Chromium: Graphics and Skia](https://www.chromium.org/developers/design-documents/graphics-and-skia/)
- [Mozilla Bug: Drawing on large canvases 2x slower than Chrome](https://bugzilla.mozilla.org/show_bug.cgi?id=1161818)

---

### 2.12 Ligatures and Complex Scripts on Canvas

#### The Good News

Canvas `fillText()` uses the platform's text shaper, so ligatures and complex scripts generally work correctly when rendering full strings. Arabic, Indic scripts, and programming ligatures (Fira Code, JetBrains Mono) render correctly if you pass the full text string to `fillText()`.

#### The Problem for Terminals

Terminals render character-by-character on a fixed grid. But ligatures require multiple characters to be shaped together. A `fi` ligature in "file" occupies two cells but renders as one glyph.

**The fundamental tension:** Ligatures break the 1:1 relationship between codepoint and glyph that terminal rendering relies on.

#### Solutions

1. **Render multi-character runs.** Don't call `fillText()` per character. Instead, identify runs of characters with the same attributes and render the full run. Let the text shaper handle ligatures within the run. Then clip the result to the cell boundaries.

2. **Disable ligatures.** Set `ctx.fontVariantLigatures = 'none'` or use `font-feature-settings: "liga" 0, "calt" 0` in the CSS font string. Many terminal users prefer this for code readability.

3. **Explicit ligature support.** If you want programming ligatures, you must implement ligature detection: identify ligature sequences (e.g., `=>`, `!=`, `->`, `>=`), render the full sequence as one shaped string, and distribute the result across the constituent cells.

#### Complex Scripts (Arabic, Devanagari, etc.)

These scripts have context-dependent shaping (characters change form based on neighbors). Rendering them correctly requires:
- Passing the full word/run to the text shaper.
- Handling bidirectional text (right-to-left + left-to-right mixing).
- Using HarfBuzz or the platform shaper (Canvas `fillText()` does this automatically for full strings).

Sources:
- [HarfBuzz: Why you need a shaping engine](https://harfbuzz.github.io/why-do-i-need-a-shaping-engine.html)
- [Contour Terminal: Text Stack](https://contour-terminal.org/internals/text-stack/)
- [The Trouble with Text Rendering](https://www.mrumpler.at/the-trouble-with-text-rendering-in-skiasharp-and-harfbuzz/)

---

### 2.13 Smooth Scrolling on Canvas

#### Why It's Hard

Native browser scrolling is highly optimized -- it happens on the compositor thread, asynchronously from JavaScript. Canvas-based scrolling must be implemented entirely in JavaScript:

1. **No native scroll.** The canvas has no inherent scroll behavior. You must track scroll offset, handle wheel events, and redraw on every frame.
2. **Pixel copying is expensive.** Scrolling by N pixels means either: (a) redrawing the entire visible area, or (b) using `drawImage(canvas, 0, 0)` to shift the canvas content and only drawing the newly exposed rows.
3. **Wheel event coalescing.** Multiple wheel events may fire between frames. You must accumulate deltas and apply them once per rAF.
4. **Momentum scrolling.** On macOS, trackpad scrolling has momentum/inertia. You must simulate this or handle the native momentum events.

#### Strategies

**Strategy A: Pixel blit + partial redraw (fastest for small scrolls)**
```javascript
// Shift existing content up by scrollDelta pixels
ctx.drawImage(canvas, 0, scrollDelta, width, height - scrollDelta, 0, 0, width, height - scrollDelta);
// Clear and redraw the newly exposed strip at the bottom
ctx.clearRect(0, height - scrollDelta, width, scrollDelta);
renderRows(firstNewRow, lastNewRow);
```

**Strategy B: Full redraw (simplest, used for large scrolls)**
Clear and redraw all visible rows. With glyph atlas caching, a full redraw of ~50 rows x ~200 columns = 10,000 drawImage calls can complete in < 5ms.

**Strategy C: CSS transform (smooth, zero-JS rendering)**
Use a CSS `transform: translateY()` on the canvas element for sub-frame scrolling, with periodic canvas redraws to update content. The compositor thread handles the smooth animation.

Sources:
- [Smooth scrolling on HTML5 Canvas](https://dev.to/sip3/how-to-achieve-top-notch-scrolling-performance-using-html5-canvas-k49)
- [Mozilla Bug: Scroll input lag with Skia acceleration](https://bugzilla.mozilla.org/show_bug.cgi?id=959977)

---

### 2.14 measureText and Font Loading Limitations

#### measureText Inconsistencies

- `measureText()` results vary between browsers by up to 4px for the same font.
- `actualBoundingBoxLeft` and `actualBoundingBoxRight` fall back to 0 and width respectively in some implementations.
- Text metrics don't scale linearly with font size due to hinting and pixel rounding.
- The interaction with `devicePixelRatio` is not well-specified -- metrics may differ at different DPR values.

#### Font Loading Race Condition

Canvas does NOT auto-update when fonts load. If you measure or draw text before the font is loaded, you get metrics and rendering for a fallback font.

**Solution:**
```javascript
await document.fonts.load('16px "JetBrains Mono"');
await document.fonts.ready;
// NOW safe to measure and render
const metrics = ctx.measureText('W');
```

Always wait for `document.fonts.ready` before measuring fonts. Re-measure and re-render when fonts change.

Sources:
- [node-canvas measureText differences](https://github.com/Automattic/node-canvas/issues/331)
- [Mozilla Bug: Canvas measureText differs from DOM](https://bugzilla.mozilla.org/show_bug.cgi?id=1126391)
- [Konva: Custom fonts loading](https://konvajs.org/docs/sandbox/Custom_Font.html)

---

## Part 3: Advanced Techniques

### 3.1 How xterm.js Implements Its Canvas and WebGL Renderers

xterm.js is the reference implementation for web-based terminal rendering. Understanding its architecture is essential.

#### Canvas Renderer Architecture

```
RenderService (debounces updates)
    |
    v
IRenderer interface
    |
    +-- Canvas Renderer
    |     |
    |     +-- TextRenderLayer (canvas 1: backgrounds + glyphs)
    |     +-- SelectionRenderLayer (canvas 2: selection overlay)
    |     +-- LinkRenderLayer (canvas 3: hyperlink decorations)
    |     +-- CursorRenderLayer (canvas 4: cursor)
    |
    +-- WebGL Renderer
          |
          +-- WebGL2 program (vertex + fragment shaders)
          +-- CursorRenderLayer (reused from canvas)
          +-- LinkRenderLayer (reused from canvas)
```

#### Key Design Decisions

1. **Render layers as separate canvases:** Each layer maintains its own drawn state and diffs against new state before drawing. This makes cursor blink a trivial per-layer operation.

2. **Texture atlas (shared between Canvas and WebGL):** Characters are rasterized to the atlas using a 2D context as they're needed. The atlas is a dynamic LRU cache because the combinatorial space (16M colors x Unicode characters x styles) is too large to pre-populate.

3. **ImageBitmap for GPU co-location:** The atlas canvas is converted to an `ImageBitmap`, which the browser can keep on the GPU. `drawImage()` with an `ImageBitmap` source is faster than with a canvas source.

4. **Minimal drawn state model:** Each cell's drawn state is tracked with just enough information to detect changes: character code, foreground color index, background color index, style flags. Comparing this is O(1) per cell.

#### WebGL Renderer Specifics

- Builds a `Float32Array` containing position, texture coordinates, and color for every cell.
- Single draw call via `drawElementsInstanced` renders all cells.
- All Unicode characters, including emoji and combined characters, are cached in the atlas.
- The atlas trims glyphs to their minimal bounding rectangles for better space utilization.
- WebGL2 is required (for VAOs and instanced drawing).
- Handles context loss via the `webglcontextlost` event.

#### Performance Numbers

- Canvas renderer: 5-45x faster than DOM rendering.
- Single character change: < 0.25ms (down from ~6ms with DOM).
- WebGL renderer: "super fast and scales much better with really large viewports."

Sources:
- [VS Code Terminal Performance Improvements](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)
- [How Is New Terminal In VS Code So Fast?](https://gist.github.com/weihanglo/8b5efd2dbc4302d123af089e510f5326)
- [xterm.js WebGL Renderer PR](https://github.com/xtermjs/xterm.js/pull/1790)
- [xterm.js Dynamic Atlas PR](https://github.com/xtermjs/xterm.js/pull/1327)
- [xterm.js DeepWiki Overview](https://deepwiki.com/xtermjs/xterm.js/1-overview)

---

### 3.2 Texture Atlas Approach for Terminal Glyph Rendering

This is the foundational technique. Here is a detailed implementation guide:

#### Atlas Data Structure

```typescript
interface GlyphAtlas {
  canvas: OffscreenCanvas;         // The atlas backing store
  ctx: OffscreenCanvasRenderingContext2D;
  width: number;                    // Atlas dimensions (e.g., 2048x2048)
  height: number;

  // Packing state
  rows: AtlasRow[];                 // Active rows for packing
  currentPage: number;              // Current atlas page index
  pages: OffscreenCanvas[];         // Multiple pages when one fills up

  // Lookup
  cache: Map<string, GlyphEntry>;   // key -> atlas location
}

interface GlyphEntry {
  page: number;       // Which atlas page
  x: number;          // Source x in atlas
  y: number;          // Source y in atlas
  w: number;          // Glyph width (trimmed)
  h: number;          // Glyph height (trimmed)
  originX: number;    // Offset from cell origin to glyph origin
  originY: number;    // Offset from cell origin to glyph origin
}

interface AtlasRow {
  y: number;          // Y position of this row in the atlas
  height: number;     // Row height (tallest glyph in this row)
  x: number;          // Next available X position
}
```

#### Cache Key Design

```typescript
function glyphKey(char: string, fg: number, bg: number, style: number): string {
  // style encodes: bold(1) | italic(2) | underline(4) | strikethrough(8)
  return `${char}|${fg}|${bg}|${style}`;
}
```

For terminals with 256-color mode, the cache key space is manageable. For true-color (24-bit), consider quantizing colors or using foreground-only keys (render on transparent, composite over background at draw time).

#### Lazy Rasterization

```javascript
function getGlyph(char, fg, bg, style) {
  const key = glyphKey(char, fg, bg, style);
  let entry = atlas.cache.get(key);
  if (!entry) {
    entry = rasterizeGlyph(char, fg, bg, style);
    atlas.cache.set(key, entry);
  }
  return entry;
}

function rasterizeGlyph(char, fg, bg, style) {
  // Set font based on style
  atlasCtx.font = styleToFont(style);

  // Draw background
  atlasCtx.fillStyle = bg;
  atlasCtx.fillRect(packX, packY, cellWidth, cellHeight);

  // Draw character
  atlasCtx.fillStyle = fg;
  atlasCtx.textBaseline = 'alphabetic';
  atlasCtx.fillText(char, packX, packY + baselineOffset);

  // Record in atlas
  return { page: currentPage, x: packX, y: packY, w: cellWidth, h: cellHeight, originX: 0, originY: 0 };
}
```

#### Multi-Page Atlas (xterm.js 5.1+ approach)

Start with 512x512 pages. When a page fills, create a new one. Periodically merge small pages into larger ones (up to 4096x4096 max). This avoids the old approach of clearing the entire atlas when capacity is reached.

#### Separate Color and Grayscale Atlases

- **Grayscale atlas:** Standard text. One channel stores the glyph mask. Foreground color is applied at draw time via `globalCompositeOperation` or shader.
- **Color atlas:** Emoji and color fonts. Full RGBA.

This halves memory for the grayscale atlas and allows foreground color to be changed without re-rasterizing (useful for cursor inversion, selection highlighting).

Sources:
- [Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [Microsoft Terminal: AtlasEngine](https://deepwiki.com/microsoft/terminal/3.2-atlas-engine)
- [WebGL Text: Using a Glyph Texture](https://webglfundamentals.org/webgl/lessons/webgl-text-glyphs.html)

---

### 3.3 WebGL/WebGPU Text Rendering Techniques

#### Glyph Atlas + Instanced Drawing (xterm.js approach)

This is the most proven approach for terminal rendering:

1. Rasterize glyphs to a 2D canvas atlas (using `fillText()`).
2. Upload the atlas as a WebGL texture.
3. For each cell, create a quad with texture coordinates pointing to the glyph in the atlas.
4. Use instanced drawing to render all cells in one draw call.

Vertex data per cell:
```
struct CellVertex {
  vec2 position;      // Cell position on screen
  vec2 texCoord;      // Glyph position in atlas
  vec2 size;          // Cell size
  vec4 fgColor;       // Foreground color
  vec4 bgColor;       // Background color
}
```

#### Signed Distance Field (SDF) Fonts

SDF encodes distance-to-edge rather than pixel coverage. Benefits:
- Resolution-independent: a 16pt SDF atlas scales cleanly to 100pt+.
- Smaller texture memory: one atlas works for all sizes.
- GPU-friendly: distance-to-edge evaluation is a simple shader operation.

For terminals, SDF is **not ideal** because:
- Monospace terminal fonts require pixel-perfect hinting at small sizes. SDF loses hinting information.
- The quality advantage of SDF matters most at large sizes; terminal text is typically 10-16pt.
- Bitmap glyph atlases (as described above) produce sharper results at fixed terminal font sizes.

**MSDF (Multi-channel SDF)** improves edge sharpness over standard SDF and may be viable for terminals that need scalable text.

#### Compute Shader Approach (Zutty model)

Zutty's architecture maps perfectly to GPU compute:

1. Terminal cell data (character, colors, attributes) is stored in a Shader Storage Buffer Object (SSBO) directly in GPU memory.
2. The CPU writes cell updates directly to the SSBO via memory mapping.
3. A compute shader dispatches one invocation per cell (`DispatchCompute(nCols, nRows, 1)`).
4. Each compute invocation reads its cell data from the SSBO, looks up the glyph in the atlas texture, and writes output pixels to the framebuffer.

This is **zero-cost from the CPU perspective** once the cell data is written. The GPU does all rendering in parallel.

For WebGPU, this translates to:
```wgsl
@compute @workgroup_size(16, 16)
fn renderCells(@builtin(global_invocation_id) id: vec3<u32>) {
  let col = id.x;
  let row = id.y;
  let cell = cellBuffer[row * numCols + col];
  let glyph = glyphAtlas[cell.charCode];
  // Copy glyph pixels to output, applying cell colors
}
```

Sources:
- [How Zutty Works: OpenGL Compute Shader](https://tomscii.sig7.se/2020/11/How-Zutty-works)
- [Drawing Text in WebGPU](https://tchayen.com/drawing-text-in-webgpu-using-just-the-font-file)
- [SDF Fonts Basics](https://www.redblobgames.com/x/2403-distance-field-fonts/)
- [CSS-Tricks: Techniques for Rendering Text with WebGL](https://css-tricks.com/techniques-for-rendering-text-with-webgl/)

---

### 3.4 Efficient Cell-Based Rendering on Canvas

#### The Core Loop

```javascript
function renderDirtyC ells() {
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      if (!dirtyGrid[row * numCols + col]) continue;

      const cell = buffer.getCell(row, col);
      const drawn = drawnState[row * numCols + col];

      // Skip if identical to what's already drawn
      if (cell.char === drawn.char && cell.fg === drawn.fg &&
          cell.bg === drawn.bg && cell.style === drawn.style) {
        dirtyGrid[row * numCols + col] = false;
        continue;
      }

      const x = col * cellWidth;
      const y = row * cellHeight;

      // Draw background
      ctx.fillStyle = colorToCSS(cell.bg);
      ctx.fillRect(x, y, cellWidth, cellHeight);

      // Draw glyph from atlas
      const glyph = atlas.get(cell.char, cell.fg, cell.bg, cell.style);
      ctx.drawImage(atlas.canvas, glyph.x, glyph.y, glyph.w, glyph.h,
                    x + glyph.originX, y + glyph.originY, glyph.w, glyph.h);

      // Update drawn state
      drawn.char = cell.char;
      drawn.fg = cell.fg;
      drawn.bg = cell.bg;
      drawn.style = cell.style;
      dirtyGrid[row * numCols + col] = false;
    }
  }
}
```

#### Optimization: Batch by Background Color

```javascript
function renderOptimized() {
  // Pass 1: Backgrounds (batch by color)
  const bgRuns = computeBackgroundRuns();
  for (const [color, rects] of bgRuns) {
    ctx.fillStyle = color;
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }

  // Pass 2: Glyphs (batch by atlas page)
  for (const [page, cells] of cellsByAtlasPage) {
    for (const cell of cells) {
      const glyph = atlas.get(cell);
      ctx.drawImage(page, glyph.sx, glyph.sy, glyph.sw, glyph.sh,
                    cell.dx, cell.dy, glyph.sw, glyph.sh);
    }
  }
}
```

Background runs: merge adjacent cells with the same background into single wide rectangles to reduce `fillRect` calls from nCols to ~5-20 per row.

#### Performance Target

For a 200x50 terminal (10,000 cells):
- Full redraw with atlas: < 5ms (10,000 drawImage calls at ~0.5us each)
- Typical dirty redraw (100 cells): < 0.5ms
- Cursor blink (1 cell): < 0.1ms

Sources:
- [VS Code Terminal Performance](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)
- [Speedgrid: High-Performance Canvas Component](https://www.shipbit.de/blog/speedgrid-high-performance-canvas-component)

---

### 3.5 Web Workers + OffscreenCanvas for Parallel Rendering

#### Architecture for Terminal Rendering

```
Main Thread                          Worker Thread
-----------                          -------------
PTY data (from Tauri) ----IPC---->
Terminal state (VT parse) ------->
Cell buffer updates ----transfer-->  Receive cell buffer
                                     Render to OffscreenCanvas
                                     (glyph atlas + dirty cells)
Input events <---
Clipboard <---

Canvas displays result automatically
```

#### Implementation Pattern

```javascript
// main.js
const canvas = document.getElementById('terminal');
const offscreen = canvas.transferControlToOffscreen();
const worker = new Worker('renderer.js');
worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);

// When terminal state changes:
const cellData = new SharedArrayBuffer(numCols * numRows * CELL_SIZE);
worker.postMessage({ type: 'render', cells: cellData });

// renderer.js (worker)
let ctx;
onmessage = (e) => {
  if (e.data.type === 'init') {
    ctx = e.data.canvas.getContext('2d');
    initAtlas(ctx);
  } else if (e.data.type === 'render') {
    renderCells(e.data.cells);
  }
};
```

#### Benefits

- Main thread stays responsive for input handling, IPC with Tauri backend, and DOM operations (scrollbar, menus).
- Heavy operations (atlas rasterization, full-screen redraws) don't cause input lag.
- `SharedArrayBuffer` allows zero-copy sharing of cell data between threads.

#### Caveat

Worker rendering adds latency (one frame at minimum for the message round-trip). For a terminal, one frame of latency (16ms at 60Hz) is generally acceptable -- it's less than human perceptible latency (~50-100ms).

Sources:
- [web.dev: OffscreenCanvas with Workers](https://web.dev/articles/offscreen-canvas)
- [Evil Martians: Faster WebGL with OffscreenCanvas](https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers)

---

### 3.6 Reducing Draw Calls on Canvas

Summary of all draw call reduction techniques:

| Technique | Reduction | Applicable To |
|---|---|---|
| Glyph atlas (drawImage from cached bitmap) | 10x vs fillText | Text rendering |
| Background color run merging | 5-20x fewer fillRects | Background painting |
| Sort by fillStyle | Eliminates style change flushes | All fill operations |
| Multiple canvas layers | Eliminates redraw of unchanged layers | Cursor, selection |
| Dirty cell tracking | Only draw changed cells | Incremental updates |
| Full-redraw threshold | Avoids dirty tracking overhead for large changes | Scrolling, clear |
| Path2D for repeated shapes | Define once, draw many | Decorations |
| Skip invisible cells | Don't draw cells obscured by selection/cursor layers | All rendering |

#### The Ultimate Optimization: Single Draw Call (WebGL)

With WebGL instanced drawing, the entire terminal can be rendered in **one draw call**:
- Pack all cell data into a Float32Array vertex buffer.
- Upload once per frame.
- GPU renders all cells in parallel via instanced rendering.

This eliminates the per-cell overhead of Canvas 2D API calls entirely.

---

### 3.7 Smooth Scrolling with a Cell Grid

#### The Challenge

Terminal grids are inherently cell-aligned. Smooth (sub-cell) scrolling means showing partial rows at the top and bottom of the viewport.

#### Implementation

```javascript
let scrollOffset = 0; // Subpixel scroll offset (0 to cellHeight)
let topRow = 0;       // First fully visible row in the buffer

function onWheel(deltaY) {
  scrollOffset += deltaY;

  // Snap to row boundaries
  while (scrollOffset >= cellHeight) {
    scrollOffset -= cellHeight;
    topRow++;
  }
  while (scrollOffset < 0) {
    scrollOffset += cellHeight;
    topRow--;
  }

  topRow = clamp(topRow, 0, bufferLength - numVisibleRows);
  markFullRedraw();
}

function render() {
  ctx.save();
  ctx.translate(0, -scrollOffset); // Shift by subpixel offset

  // Render one extra row at top and bottom for partial visibility
  for (let row = topRow - 1; row <= topRow + numVisibleRows; row++) {
    renderRow(row, (row - topRow) * cellHeight);
  }

  ctx.restore();
}
```

#### CSS Transform Approach (Smoother)

Instead of redrawing every frame during scroll:
1. Render the full visible content + 1 row above/below.
2. Use `canvas.style.transform = \`translateY(${-scrollOffset}px)\`` for smooth subpixel movement.
3. When scrollOffset crosses a cell boundary, redraw the canvas content and reset the transform.

The CSS transform is composited on the GPU's compositor thread, providing buttery-smooth animation without JavaScript jank.

---

### 3.8 Cursor Rendering and Animation

#### Cursor Types

| Style | Rendering |
|---|---|
| Block | `fillRect` with inverted foreground/background |
| Beam (line) | `fillRect` with 2px width at cell left edge |
| Underline | `fillRect` with 2px height at cell bottom |

#### Blink Animation

Use a dedicated CursorRenderLayer canvas (as xterm.js does). The blink animation only redraws this tiny canvas:

```javascript
let cursorVisible = true;
let blinkInterval = 500; // ms

function blinkCursor(timestamp) {
  const phase = Math.floor(timestamp / blinkInterval) % 2;
  const shouldShow = phase === 0;

  if (shouldShow !== cursorVisible) {
    cursorVisible = shouldShow;
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    if (cursorVisible) {
      drawCursor(cursorCtx, cursorRow, cursorCol);
    }
  }

  requestAnimationFrame(blinkCursor);
}
```

This approach costs < 0.1ms per blink toggle because only the cursor layer redraws.

---

### 3.9 Selection Rendering

#### Architecture

Use a dedicated SelectionRenderLayer canvas with semi-transparent fill:

```javascript
function renderSelection(startCell, endCell) {
  selCtx.clearRect(0, 0, selCanvas.width, selCanvas.height);

  if (!startCell || !endCell) return;

  selCtx.fillStyle = 'rgba(100, 150, 255, 0.3)'; // Selection color

  const [start, end] = normalizeSelection(startCell, endCell);

  for (let row = start.row; row <= end.row; row++) {
    const colStart = (row === start.row) ? start.col : 0;
    const colEnd = (row === end.row) ? end.col : numCols - 1;

    selCtx.fillRect(
      colStart * cellWidth,
      row * cellHeight,
      (colEnd - colStart + 1) * cellWidth,
      cellHeight
    );
  }
}
```

The selection overlay is composited over the text layer by the browser's compositor (since it's a separate canvas with higher z-index). No need for complex blending code.

---

### 3.10 Sixel and Inline Image Rendering

#### Sixel Protocol

Sixel encodes images as ASCII character sequences. Each character represents 6 vertical pixels in a single-pixel-wide column. The terminal decodes the sixel data into a pixel buffer.

#### Canvas Implementation

```javascript
function renderSixelImage(imageData, cellX, cellY, widthCells, heightCells) {
  // imageData is a decoded pixel buffer (Uint8ClampedArray)
  const imgData = new ImageData(imageData, pixelWidth, pixelHeight);

  // Render to a temporary canvas
  const tmpCanvas = new OffscreenCanvas(pixelWidth, pixelHeight);
  const tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.putImageData(imgData, 0, 0);

  // Draw scaled to cell grid
  ctx.drawImage(tmpCanvas,
    cellX * cellWidth, cellY * cellHeight,
    widthCells * cellWidth, heightCells * cellHeight);
}
```

#### Performance Considerations

- Sixel images can be large (thousands of pixels). Decode in a Web Worker.
- Cache decoded images by their content hash. Sixel data rarely changes once displayed.
- Use `createImageBitmap()` for GPU-resident image data.
- For the Kitty graphics protocol (superior to Sixel), images arrive as base64-encoded PNG/RGB data. Decode with `createImageBitmap(blob)` for maximum performance.

Sources:
- [Terminal Graphics Protocols: Kitty, Sixel, iTerm2](https://akmatori.com/blog/terminal-graphics-protocols)
- [libsixel](https://saitoha.github.io/libsixel/)
- [Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)

---

## Part 4: Canvas in Tauri/WebView Context

### 4.1 Canvas Performance in Tauri vs Regular Browsers

Tauri uses the system's native WebView:
- **macOS:** WKWebView (WebKit engine, same as Safari)
- **Windows:** WebView2 (Chromium engine, same as Edge)
- **Linux:** WebKitGTK (WebKit engine)

#### Key Differences from Regular Browsers

1. **No multi-process architecture.** Tauri's WebView runs in the application process. There's no separate GPU process like in Chrome. This means Canvas rendering competes with application logic for CPU time.

2. **macOS WKWebView 60fps cap.** On macOS 13-15 (Ventura through Sequoia), WKWebView caps requestAnimationFrame at 60fps regardless of display refresh rate. This is a significant limitation for ProMotion displays (120Hz).
   - **Workaround:** The `tauri-plugin-macos-fps` plugin toggles WebKit's internal `PreferPageRenderingUpdatesNear60FPSEnabled` preference to unlock native refresh rates.
   - **macOS 26+ (Tahoe):** Apple removed the cap. WKWebView renders at native refresh rate by default.
   - **App Store risk:** The plugin uses private WebKit API. Apps using it will be rejected from the Mac App Store.

3. **Memory constraints.** Tauri apps share the system WebView's memory limits. WKWebView on macOS has stricter canvas memory limits than Chrome.

4. **No DevTools by default.** Debugging Canvas performance requires enabling WebView inspector explicitly in Tauri config.

#### Performance Comparison

A Babylon.js benchmark showed performance differences between Safari (standalone) and WKWebView (Tauri). The WebView sometimes shows slightly lower performance due to the overhead of running within the Tauri host process.

On Windows, WebView2 generally matches Chrome's Canvas performance since it uses the same Chromium engine. However, WebView2 Runtime 142 introduced a regression where canvas FPS dropped from ~160 to ~50 at 4K+ resolution with stacked canvas layers.

Sources:
- [tauri-plugin-macos-fps](https://github.com/userFRM/tauri-plugin-macos-fps)
- [Tauri bug: 60fps on macOS](https://github.com/tauri-apps/tauri/issues/13978)
- [Babylon.js: Safari vs WKWebView performance](https://forum.babylonjs.com/t/performance-between-safari-and-wkwebview-tauri/60811)
- [WebView2 canvas 4K regression](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5426)

---

### 4.2 Tauri-Specific Optimizations and Limitations

#### Tauri IPC and Rendering Coordination

Tauri commands (Rust -> JS communication) are asynchronous. PTY data flows:

```
PTY (Rust) -> Tauri command -> JS callback -> Terminal parse -> Canvas render
```

**Optimization:** Use `SharedArrayBuffer` or `ArrayBuffer` transfer for bulk PTY data to avoid serialization overhead. Tauri supports binary payloads in IPC.

#### WebView Compositor Interaction

Tauri's WRY library (Rust WebView abstraction) creates the WebView as a native window child. The WebView's compositor runs within the OS window compositor chain:

```
Application Window (Tauri/WRY)
  -> Native WebView (WKWebView / WebView2 / WebKitGTK)
    -> WebView Compositor
      -> Canvas Layer (GPU texture)
      -> DOM Layers
    -> OS Compositor
  -> Display
```

For maximum performance, minimize DOM elements alongside the canvas. A single full-window canvas with no overlapping DOM elements gives the compositor the least work.

#### wgpu Overlay Approach

An advanced option discussed in the Tauri community: render directly with wgpu (Rust GPU abstraction) and composite the result into the WebView. This bypasses Canvas entirely but introduces complexity:
- Two-window stacking (wgpu window under transparent WebView).
- Platform-specific compositor issues (Wayland, Windows API).
- Currently experimental and not production-ready.

For t-bias, the pragmatic approach is Canvas-based rendering within the WebView, with the option to explore wgpu overlay in the future if Canvas performance proves insufficient.

Sources:
- [Tauri Architecture](https://v2.tauri.app/concept/architecture/)
- [Tauri Discussion: Render wgpu as webview overlay](https://github.com/tauri-apps/tauri/discussions/11944)
- [Tauri: Exploring System Webviews](https://dev.to/shrsv/exploring-system-webviews-in-tauri-native-rendering-for-efficient-cross-platform-apps-9hl)

---

### 4.3 WKWebView (macOS) vs WebView2 (Windows) for Canvas

| Aspect | WKWebView (macOS) | WebView2 (Windows) |
|---|---|---|
| **Engine** | WebKit (same as Safari) | Chromium (same as Edge) |
| **Canvas 2D Backend** | CoreGraphics + Metal compositing | Skia + Ganesh/Graphite GPU |
| **WebGL2** | Supported (Metal-backed) | Supported (ANGLE/Direct3D) |
| **WebGPU** | Supported (2026) | Supported (2026) |
| **Frame Rate Cap** | 60fps on macOS 13-15; native on macOS 26+ | No cap (matches display) |
| **Canvas Memory Limit** | ~256MB total across all canvases | Higher (Chromium limits) |
| **Text Rendering** | CoreText (macOS native) | DirectWrite via Skia |
| **DevTools** | Safari Web Inspector (opt-in) | Edge DevTools (opt-in) |
| **4K Performance** | Generally stable | Regression in Runtime 142 |
| **Scrolling** | Micro-lag reported vs Safari standalone | Generally smooth |

**macOS-specific issue:** WKWebView scroll behavior differs subtly from Safari standalone. Users report micro-lag during scrolling in Tauri apps that doesn't occur in Safari. This may affect smooth terminal scrolling.

**Windows-specific issue:** WebView2 runtime auto-updates. A runtime update can regress canvas performance (as with Runtime 142). Tauri apps should test against latest WebView2 runtime and potentially pin a minimum version.

Sources:
- [Tauri Discussion: WKWebView scroll micro-lag](https://github.com/orgs/tauri-apps/discussions/8436)
- [WebView2 4K canvas regression](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5426)
- [Tauri: Webview Versions](https://v2.tauri.app/reference/webview-versions/)

---

## Appendix: Reference Architectures

### A.1 Terminal Renderers Comparison

| Terminal | Rendering API | Glyph Atlas | Shaping | Frame Time | Platform |
|---|---|---|---|---|---|
| **xterm.js (Canvas)** | Canvas 2D | Dynamic, multi-page | Native (browser) | < 0.25ms incremental | Browser |
| **xterm.js (WebGL)** | WebGL2 | Dynamic, multi-page | Native (browser) | Sub-ms | Browser |
| **Warp** | Metal | GPU texture atlas | HarfBuzz | 1.9ms avg | macOS |
| **Windows Terminal** | Direct3D + HLSL | AtlasEngine | DirectWrite | Sub-ms | Windows |
| **Ghostty** | Metal / OpenGL | GPU texture atlas | FreeType + HarfBuzz | Sub-ms | macOS / Linux |
| **Kitty** | OpenGL | GPU sprite cache | HarfBuzz | Lowest latency tested | macOS / Linux |
| **Zutty** | OpenGL ES 3.1 (Compute) | GPU SSBO + atlas | N/A (ASCII focus) | Zero CPU cost | Linux |
| **Alacritty** | OpenGL | GPU texture atlas | HarfBuzz | Sub-ms | Cross-platform |
| **Beamterm** | WebGL2 / OpenGL 3.3 | Dynamic font atlas | HarfBuzz (opt) | Sub-ms (45k cells) | Browser / Native |

### A.2 Recommended Architecture for t-bias

```
┌─────────────────────────────────────────────────────────────────┐
│  Tauri Host (Rust)                                              │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ PTY Layer │  │ VT Emulator  │  │ Terminal Buffer          │ │
│  │ (async)   │->│ (Pretext)    │->│ (cell grid + scrollback) │ │
│  └───────────┘  └──────────────┘  └────────────┬─────────────┘ │
│                                                 │ IPC (binary)  │
├─────────────────────────────────────────────────┼───────────────┤
│  WebView (WKWebView / WebView2)                 │               │
│  ┌──────────────────────────────────────────────┼─────────────┐ │
│  │  Main Thread                                 v             │ │
│  │  ┌──────────────┐  ┌─────────────────────────────────────┐ │ │
│  │  │ Input Handler │  │ Cell Buffer (SharedArrayBuffer)     │ │ │
│  │  │ + Clipboard   │  │ (written by main, read by worker)   │ │ │
│  │  └──────────────┘  └─────────────┬───────────────────────┘ │ │
│  │                                   │ transfer                │ │
│  │  ┌────────────────────────────────┼───────────────────────┐ │ │
│  │  │  Render Worker                 v                       │ │ │
│  │  │  ┌────────────────────────────────────────────────────┐│ │ │
│  │  │  │ Glyph Atlas (OffscreenCanvas, multi-page)          ││ │ │
│  │  │  │ - Lazy rasterization via fillText()                ││ │ │
│  │  │  │ - Grayscale + Color atlases                        ││ │ │
│  │  │  └────────────────────────────────────────────────────┘│ │ │
│  │  │  ┌────────────────────────────────────────────────────┐│ │ │
│  │  │  │ Cell Renderer                                      ││ │ │
│  │  │  │ - Dirty cell tracking                              ││ │ │
│  │  │  │ - Background run merging                           ││ │ │
│  │  │  │ - drawImage from atlas                             ││ │ │
│  │  │  └────────────────────────────────────────────────────┘│ │ │
│  │  └────────────────────────────────────────────────────────┘ │ │
│  │                                                             │ │
│  │  Canvas Stack (CSS z-index):                                │ │
│  │  [z:0] Text + Background  (OffscreenCanvas via worker)      │ │
│  │  [z:1] Selection Overlay  (small, main thread)              │ │
│  │  [z:2] Cursor             (small, main thread)              │ │
│  │  Hidden <textarea>        (for clipboard integration)       │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### A.3 Performance Targets

| Metric | Target | Rationale |
|---|---|---|
| Full redraw (10k cells) | < 5ms | Leaves 11ms of frame budget |
| Incremental update (100 cells) | < 0.5ms | Typical typing/small output |
| Cursor blink | < 0.1ms | Dedicated layer, single cell |
| Input-to-screen latency | < 16ms | One frame at 60Hz |
| Memory (1080p, 2x DPR) | < 100MB | 4 canvas layers + atlas |
| Atlas rasterization (new glyph) | < 1ms | Amortized over many frames |
| Scroll (full viewport) | < 8ms | Pixel blit + partial redraw |

### A.4 Key Decisions and Rationale

1. **Start with Canvas 2D, not WebGL.** Canvas 2D gives native text shaping for free. Optimize with glyph atlas + dirty tracking before considering WebGL. The complexity of WebGL (context loss, shader management, manual text shaping) is not justified until Canvas 2D proves insufficient.

2. **Use OffscreenCanvas in a Worker for the text layer.** This is the highest-impact architectural decision. It frees the main thread entirely from rendering.

3. **Separate canvas layers for cursor and selection.** These change independently and frequently. Isolating them avoids full text redraws.

4. **Dynamic multi-page glyph atlas.** Pre-populating is impossible (16M+ possible combinations). Lazy rasterization with LRU eviction is the proven approach.

5. **Hidden textarea for clipboard.** It's the only reliable cross-browser approach for copy/paste with canvas-rendered content.

6. **Handle WKWebView 60fps cap.** Use `tauri-plugin-macos-fps` for macOS 13-15. On macOS 26+, the cap is removed. Design the renderer to work correctly at both 60Hz and 120Hz+.

7. **Design for future WebGL/WebGPU migration.** Use an `IRenderer` interface (like xterm.js) so the rendering backend can be swapped without changing terminal logic. The cell buffer, dirty tracking, and glyph atlas cache key logic are backend-agnostic.

---

## Key Sources

### Official Documentation
- [MDN: Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- [MDN: OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [MDN: TextMetrics](https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics)
- [MDN: Optimizing Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
- [Chrome: Canvas2D Updates](https://developer.chrome.com/blog/canvas2d)
- [Chrome: GPU Accelerated Compositing](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)

### Terminal Renderer Implementations
- [xterm.js WebGL Renderer PR](https://github.com/xtermjs/xterm.js/pull/1790)
- [xterm.js Dynamic Atlas PR](https://github.com/xtermjs/xterm.js/pull/1327)
- [VS Code Terminal Performance Blog](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)
- [How Is VS Code Terminal So Fast?](https://gist.github.com/weihanglo/8b5efd2dbc4302d123af089e510f5326)
- [Microsoft Terminal AtlasEngine](https://github.com/microsoft/terminal/pull/11623)
- [Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [How Zutty Works](https://tomscii.sig7.se/2020/11/How-Zutty-works)
- [Ghostty DeepWiki](https://deepwiki.com/ghostty-org/ghostty)
- [Beamterm](https://github.com/junkdog/beamterm)
- [Contour Terminal Text Stack](https://contour-terminal.org/internals/text-stack/)

### Performance and Optimization
- [web.dev: OffscreenCanvas](https://web.dev/articles/offscreen-canvas)
- [web.dev: Canvas Performance](https://web.dev/articles/canvas-performance)
- [AG Grid: Canvas Rendering Best Practices](https://blog.ag-grid.com/optimising-html5-canvas-rendering-best-practices-and-techniques/)
- [Supercharging Canvas fillText](https://www.mirkosertic.de/blog/2015/03/tuning-html5-canvas-filltext/)
- [Chrome: willReadFrequently explained](https://www.schiener.io/2024-08-02/canvas-willreadfrequently)

### Tauri-Specific
- [Tauri Architecture](https://v2.tauri.app/concept/architecture/)
- [tauri-plugin-macos-fps](https://github.com/userFRM/tauri-plugin-macos-fps)
- [Tauri: 60fps macOS bug](https://github.com/tauri-apps/tauri/issues/13978)
- [Tauri: WKWebView scroll micro-lag](https://github.com/orgs/tauri-apps/discussions/8436)

### Text Rendering
- [Understanding Canvas Text Metrics](https://erikonarheim.com/posts/canvas-text-metrics/)
- [Drawing Text in WebGPU](https://tchayen.com/drawing-text-in-webgpu-using-just-the-font-file)
- [SDF Fonts Basics](https://www.redblobgames.com/x/2403-distance-field-fonts/)
- [CSS-Tricks: WebGL Text Rendering](https://css-tricks.com/techniques-for-rendering-text-with-webgl/)
- [HarfBuzz: Why Shaping Engines](https://harfbuzz.github.io/why-do-i-need-a-shaping-engine.html)
