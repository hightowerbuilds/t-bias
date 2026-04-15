# t-bias Roadmap: Building the World's Best Canvas-Rendered Terminal

> High-level development phases. Each phase will be unpacked into detailed implementation plans.

---

## Phase 1 — Architectural Restructure

**Goal**: Decouple everything. Create the clean separations that every successful terminal eventually migrated toward — but do it first, not as a rewrite.

The current codebase works but is tightly coupled: parsing, state management, and rendering live in a single flow. Every top terminal (xterm.js, Alacritty, WezTerm, Ghostty) learned the hard way that separating terminal emulation from rendering is non-negotiable. xterm.js introduced `IRenderer` to swap DOM/Canvas/WebGL without touching terminal logic. Alacritty extracted `alacritty_terminal` as a standalone crate. WezTerm has 19 crates with clean boundaries. Ghostty ships `libghostty` with zero UI dependencies.

**What this phase establishes**:
- A renderer interface (`IRenderer`) that the terminal core talks to — never the other way around
- Terminal emulation (parser + screen + buffer) as a self-contained module with no rendering knowledge
- A defined IPC contract between Rust and the frontend
- A layered canvas architecture (text, selection, cursor as independent surfaces)
- The scaffolding for OffscreenCanvas + Web Worker rendering

**Why first**: Every phase after this depends on clean boundaries. Optimizing rendering means swapping renderers. Hardening emulation means testing it in isolation. Optimizing IPC means changing the data format without touching either side's internals. Without this phase, every subsequent phase requires refactoring what came before.

---

## Phase 2 — Canvas 2D Rendering Engine

**Goal**: Build a rendering engine that extracts maximum performance from Canvas 2D before ever considering WebGL.

The research is clear: Canvas 2D with a glyph atlas closes most of the gap with WebGL for terminal workloads. `fillText()` uncached costs ~10ms; cached via `drawImage()` from an atlas drops to ~1ms. xterm.js proved this — their Canvas renderer with a dynamic texture atlas handles typical terminal workloads at sub-millisecond incremental frame times.

**What this phase builds**:
- Dynamic multi-page glyph atlas with lazy rasterization and LRU eviction
- Dirty-cell tracking (not just dirty rows — cell-level granularity)
- Background-run merging to minimize draw calls
- OffscreenCanvas rendering in a Web Worker (frees main thread entirely)
- Multi-layer canvas stack: text+bg (worker), selection overlay (main), cursor (main)
- High-DPI rendering done correctly (device pixel ratio scaling, crisp text)
- Frame skipping for high-throughput scenarios (`cat huge_file.txt`)

**Why before emulation hardening**: The renderer is the bottleneck users feel. A correct terminal that renders slowly is unusable. A fast terminal with minor emulation gaps is usable daily.

---

## Phase 3 — Terminal Emulation Core

**Goal**: Achieve VT conformance that rivals Ghostty and Kitty. Handle Unicode correctly from the ground up, not as a patch.

Most terminals built on `wcwidth()` and spent years fixing the consequences. Grapheme cluster support (UAX #29) changes how cells are stored, how the cursor moves, and how selection works. Doing it now — on a young codebase — avoids the multi-year migration every other terminal went through.

**What this phase delivers**:
- UAX #29 grapheme cluster segmentation (ASCII fast path, complex grapheme slow path)
- Grapheme storage: single codepoints inline, multi-codepoint graphemes in a side map (Ghostty's pattern)
- Memory-efficient cell storage with shared style ref-counting
- Asymmetric buffer design: fast random-access active screen, compact append-only scrollback
- Parser hardened against all edge cases (DCS, APC, PM passthrough; malformed sequences; C1 controls)
- Conformance validated against vttest and esctest across VT100-VT525 levels

**Why this ordering**: Phase 2 gave us a fast renderer. Now we make what it renders correct. The `IRenderer` interface from Phase 1 means emulation changes don't require renderer changes.

---

## Phase 4 — Data Pipeline & IPC Optimization

**Goal**: Eliminate the IPC boundary as a bottleneck. The Rust-to-JS bridge is the single biggest performance risk in a Tauri terminal architecture.

Every byte of shell output currently crosses the Tauri IPC bridge as a JSON-serialized string event. At high throughput (compiling, log tailing, `cat` of large files), this serialization/deserialization overhead dominates. The research shows terminals solve this with binary protocols, shared memory, and batched updates.

**What this phase implements**:
- Binary IPC protocol (no JSON serialization for terminal data)
- SharedArrayBuffer for zero-copy data sharing between Rust and the render worker
- Batched terminal state updates (coalesce rapid output into single render passes)
- Adaptive rendering: detect high-throughput mode and skip intermediate frames
- Parser performance profiling against real-world terminal recordings (Ghostty's approach of tuning against 4GB of real session data)
- Latency measurement infrastructure (input-to-photon pipeline)

**Why here**: Phases 2 and 3 made rendering and emulation fast in isolation. This phase makes the pipeline between them fast. Without this, we have a fast renderer starved by a slow data pipe.

---

## Phase 5 — Input, Interaction & Accessibility

**Goal**: Make the terminal a joy to interact with, and make it usable by everyone.

Input handling is where terminals silently fail. Key encoding inconsistencies, broken modifier combinations, and missing accessibility are the norm. The Kitty Keyboard Protocol exists specifically because legacy input encoding is ambiguous — 7+ major terminals have adopted it.

**What this phase delivers**:
- Kitty Keyboard Protocol support (unambiguous key encoding, progressive enhancement)
- Robust selection: word-wise double-click, line-wise triple-click, rectangular select
- Clipboard integration via hidden `<textarea>` (the only reliable cross-browser/WebView approach)
- Search within terminal output (scrollback search with highlighting)
- Hidden accessible DOM layer synchronized with canvas (the xterm.js pattern — the only way to support screen readers with non-DOM rendering)
- Screen reader announcements for terminal activity
- URL detection and clickable hyperlinks (OSC 8)

**Why here**: The terminal is now fast and correct. This phase makes it humane. Accessibility in particular must be designed in, not bolted on — the hidden DOM layer needs to mirror the terminal state that Phase 3 built.

---

## Phase 6 — WebGL/WebGPU Renderer

**Goal**: Break through the Canvas 2D performance ceiling. Achieve sub-millisecond full redraws at 4K resolution with 120Hz+ refresh rates.

Canvas 2D with a glyph atlas is fast enough for typical use. But at 4K with a large terminal (200+ columns, 60+ rows, 12k+ cells), Canvas 2D hits performance cliffs — particularly on WKWebView (macOS) which caps at 60fps on macOS 13-15. WebGL instanced drawing and eventually WebGPU compute shaders eliminate these ceilings.

**What this phase builds**:
- WebGL2 renderer behind the `IRenderer` interface (drop-in replacement for Canvas 2D)
- GPU-resident texture atlas (multiple 512x512 textures, uploaded incrementally)
- Instanced drawing: one draw call renders all cells (xterm.js's `drawElementsInstanced` pattern)
- WebGL context loss recovery (full state rebuild on `webglcontextlost`)
- Canvas 2D preserved as automatic fallback
- WebGPU renderer as experimental option (compute shader per-cell model, a la Zutty)
- Benchmarking suite: Canvas 2D vs WebGL2 vs WebGPU across platforms and display configs

**Why this late**: The `IRenderer` interface from Phase 1 makes this a backend swap, not a rewrite. All terminal logic, IPC, input handling, and accessibility are untouched. We validated correctness on Canvas 2D, now we optimize the rendering path.

---

## Phase 7 — Rich Features & Extensions

**Goal**: Support the modern terminal ecosystem — images, ligatures, advanced font rendering, and multiplexing.

This is where the terminal goes from "excellent emulator" to "complete terminal platform." Image protocols, font shaping, and multiplexing are the features that differentiate best-in-class terminals from merely good ones.

**What this phase adds**:
- Kitty graphics protocol (inline images in the terminal)
- Sixel graphics support
- HarfBuzz-equivalent text shaping (ligatures, complex scripts, combining marks)
- Async font fallback with codepoint-to-font caching
- Tabs and split panes with independent PTY sessions
- Terminal multiplexing (session persistence, remote attach)
- Configurable theming with hot-reload
- Notifications (OSC 9, OSC 777)

**Why last among features**: Each of these is a self-contained addition that doesn't change the core architecture. Image protocols layer onto the renderer. Ligatures layer onto the glyph atlas. Multiplexing layers onto the PTY management. The foundation must be solid first.

---

## Phase 8 — World-Class Polish

**Goal**: The difference between a great terminal and the best terminal is in the details no one sees until they're missing.

This is the phase where t-bias stops being a project and becomes a product. Cross-platform consistency, startup performance, configuration ergonomics, extensibility, and community are what make a terminal someone's daily driver.

**What this phase refines**:
- Cross-platform optimization (WKWebView quirks on macOS, WebView2 on Windows, platform-specific PTY tuning)
- Sub-100ms startup (parallel initialization, lazy module loading)
- Configuration system (file-based, hot-reloadable, well-documented defaults)
- Plugin/extension architecture for community contributions
- Comprehensive documentation and onboarding
- Performance regression CI (automated benchmarks against real terminal recordings)
- Community feedback loop and iterative refinement

**Why last**: Polish on an unstable foundation is wasted effort. Polish on a solid foundation compounds. Every phase before this built something that works. This phase makes it feel inevitable.

---

## Phase Summary

| Phase | Name | Core Question It Answers |
|-------|------|--------------------------|
| 1 | Architectural Restructure | Can each piece evolve independently? |
| 2 | Canvas 2D Rendering Engine | Is it fast enough to use daily? |
| 3 | Terminal Emulation Core | Is it correct enough to trust? |
| 4 | Data Pipeline & IPC | Can it handle real-world throughput? |
| 5 | Input, Interaction & Accessibility | Is it a joy to use for everyone? |
| 6 | WebGL/WebGPU Renderer | Can it render anything at any resolution instantly? |
| 7 | Rich Features & Extensions | Does it do everything a modern terminal should? |
| 8 | World-Class Polish | Would someone choose this over every alternative? |

---

# Phase Breakdowns

---

## Phase 1 — Architectural Restructure (Detailed Steps)

The current codebase has ~1,750 lines across 7 files. Everything works, but the pieces are entangled: `CanvasRenderer.draw()` reaches directly into `Screen` internals. `TerminalEmulator` owns the parser, screen, renderer, selection, input handling, cursor blink, and mouse encoding all in one class. There's no way to swap the renderer, test the emulator headlessly, or move rendering to a worker without touching everything.

This phase creates the seams that every subsequent phase depends on.

---

### Step 1.1 — Define the Renderer Interface (`IRenderer`)

**What**: Create a `src/terminal/IRenderer.ts` interface that defines the contract between the terminal core and any rendering backend.

**The interface should expose**:
```
- draw(state: RenderState): void     // Full render from a snapshot of terminal state
- resize(cols, rows): void           // Grid dimensions changed
- gridSize(widthPx, heightPx): {cols, rows}  // Calculate grid from pixel dimensions
- cellWidth: number                  // Read-only metric
- cellHeight: number                 // Read-only metric
- dispose(): void                    // Cleanup
```

**Key design decision**: The renderer receives a `RenderState` — a plain data snapshot — not a reference to `Screen`. The renderer never calls methods on the terminal. This is the inversion that makes everything else possible.

`RenderState` contains:
- A way to read cell data (either a flat buffer or a `getCell(row, col)` accessor)
- Cursor position, visibility, shape, blink state
- Selection bounds (start/end, active flag)
- Viewport offset
- Grid dimensions (cols, rows)

**Why a snapshot**: If the renderer runs in a worker (Phase 2), it can't hold a reference to a main-thread `Screen` object. The data must be serializable or backed by shared memory.

**Current state → target**: `CanvasRenderer.draw(screen, cursorBlink, selection)` reaches into `screen.cursorX`, `screen.cursorY`, `screen.getCell()`, etc. After this step, it receives a structured `RenderState` instead.

---

### Step 1.2 — Extract Terminal State from the Orchestrator

**What**: `TerminalEmulator` currently holds screen, parser, renderer, selection, input mapping, cursor blink, and mouse encoding. Split this into:

1. **`TerminalCore`** — Owns parser + screen. Pure logic, no DOM, no Canvas. Accepts input as strings, emits state. This is the module that could run in a worker or be tested headlessly.

2. **`TerminalHost`** — The DOM-aware orchestrator. Owns the canvas, attaches event listeners, manages cursor blink, delegates keyboard/mouse to `TerminalCore`, pulls `RenderState` from the core and passes it to the renderer.

**Current coupling to break**:
- `TerminalEmulator.handleKeyDown` calls `this.screen.resetViewport()`, `this.screen.applicationCursor`, `this.screen.bracketedPaste` — the host needs a way to query terminal modes without reaching into screen internals.
- `TerminalEmulator.encodeMouse` builds escape sequences using `this.screen.mouseSgr` — mouse encoding logic should live in or near the core, not the host.
- `TerminalEmulator.scheduleDraw` calls `this.renderer.draw(this.screen, ...)` — the host should instead ask the core for a `RenderState` and pass that to the renderer.

**Target API**:
```
TerminalCore:
  .write(data: string)            // Feed PTY output
  .input(data: string)            // Feed user input (keyboard sequences)
  .resize(cols, rows)             // Resize
  .getRenderState(): RenderState  // Snapshot for the renderer
  .modes: TerminalModes           // Read-only mode flags (appCursor, bracketedPaste, mouseEnabled...)
  .scrollViewport(delta)
  .resetViewport()
  .getSelectedText(sel): string

TerminalHost:
  // DOM owner — canvas, events, blink timer
  // Glues TerminalCore ↔ IRenderer ↔ Tauri IPC
```

---

### Step 1.3 — Decouple Selection from Screen

**What**: `Selection.getText(screen)` currently reaches into `Screen` to extract cell text. Selection should be a pure data structure (anchor, head, active) that the core uses to extract text when asked.

Move `getText` to `TerminalCore.getSelectedText(selection)` — the core knows how to walk its own cells. Selection itself only stores coordinates and state.

This also positions selection for the multi-layer canvas in Phase 2 — the selection layer doesn't need access to the screen, just the selection bounds.

---

### Step 1.4 — Define the IPC Contract

**What**: Formalize the messages between Rust and the frontend. Currently there are 3 Tauri commands (`spawn_shell`, `write_to_pty`, `resize_pty`) and 2 events (`pty-output`, `pty-exit`). This works but is implicit.

Create a `src/ipc/types.ts` that explicitly defines:
- All commands the frontend can invoke
- All events the backend can emit
- The data shape for each

This doesn't change behavior yet — it documents and type-checks what already exists. But it creates the seam where Phase 4 (binary IPC) will plug in.

---

### Step 1.5 — Prepare Multi-Canvas Scaffolding

**What**: The current single `<canvas>` will become a stack of canvases in Phase 2. Prepare the DOM structure now:

- `Terminal.tsx` creates a container `<div>` with `position: relative`
- Inside: a primary canvas (text + backgrounds), a selection canvas, a cursor canvas — all `position: absolute`, stacked via z-index
- For now, only the primary canvas is active — the selection and cursor canvases are empty placeholders
- The `IRenderer` interface doesn't need to know about layers (that's an implementation detail of the Canvas2D renderer)

This avoids a DOM restructure in Phase 2 when it matters most.

---

### Step 1.6 — Verify Everything Still Works

**What**: After all restructuring, the terminal must behave identically. No new features, no new bugs.

**Verification**:
- Shell spawns, input works, output renders
- Cursor blink, selection, copy, scrollback all function
- Mouse tracking works in both normal and SGR mode
- Resize handles correctly
- Alt screen (vim, htop) works

This step is not optional. Architectural refactors that break behavior create compound bugs that are impossible to trace later.

---

## Phase 2 — Canvas 2D Rendering Engine (Detailed Steps)

This is where t-bias goes from "a terminal that renders" to "a terminal with a rendering engine." The current renderer calls `fillText()` for every visible character every frame. On a 120-column, 40-row terminal that's 4,800 `fillText()` calls per frame — each one triggering font resolution, shaping, and rasterization. The research shows this costs 6-10ms uncached. With a glyph atlas and `drawImage()`, the same work costs ~1ms.

---

### Step 2.1 — Build the Glyph Atlas

**What**: A dynamic texture atlas that caches rasterized glyphs on an offscreen canvas. Instead of calling `fillText()` per cell every frame, we call it once per unique glyph and blit from the cache forever after.

**Architecture**:
- An `OffscreenCanvas` (or regular canvas) serves as the atlas texture
- Start with a single 1024x1024 page; grow to multi-page when needed
- Each atlas entry is keyed by: `char + fontVariant + fgColor` (the minimal set that produces a unique glyph bitmap)
- Atlas entries are packed in rows by cell height (all entries in a row have the same height)
- A `Map<string, AtlasEntry>` maps glyph keys to atlas coordinates (`{page, x, y, w, h}`)

**Rasterization flow**:
1. For each cell to render, compute the glyph key
2. Look up the key in the atlas map
3. **Cache hit**: `ctx.drawImage(atlasCanvas, sx, sy, sw, sh, dx, dy, dw, dh)` — a single blit
4. **Cache miss**: `fillText()` the glyph onto the atlas canvas at the next free slot, then blit

**LRU eviction**: When an atlas page fills up, evict least-recently-used entries. For a terminal, this rarely triggers — the working set of glyphs is small (ASCII + a few hundred common characters).

**Why this is the single biggest performance win**: `drawImage()` from a same-origin canvas is hardware-accelerated as a texture blit. No font resolution, no shaping, no rasterization. The GPU just copies pixels.

---

### Step 2.2 — Upgrade to Cell-Level Dirty Tracking

**What**: Replace the current row-hash dirty tracking with per-cell tracking.

**Current state**: `Renderer.hashRow()` computes an FNV-1a hash over every cell in a row. If the hash differs, the entire row is redrawn. This means one character change redraws 120+ cells.

**Target**: A `dirtyGrid: Uint8Array(cols * rows)` where each byte is 0 (clean) or 1 (dirty). When `Screen` modifies a cell, it marks that cell dirty. The renderer only redraws dirty cells.

**Implementation**:
- `TerminalCore` maintains the dirty grid alongside the cell buffer
- On `write()`, any cell that changes gets marked dirty
- `getRenderState()` includes the dirty grid
- The renderer iterates only dirty cells (or falls back to full redraw when >50% are dirty)
- After rendering, the dirty grid is cleared

**Threshold optimization**: If `dirtyCount > cols * rows * 0.5`, skip per-cell logic and do a full redraw (clearing the canvas once is cheaper than 2,400 individual cell clears).

---

### Step 2.3 — Background Run Merging

**What**: Adjacent cells often share the same background color. Instead of drawing one `fillRect` per cell, merge adjacent cells with identical backgrounds into a single rectangle.

**Current state**: The renderer draws background per cell in the inner loop: `ctx.fillRect(x, y, w, cellHeight)` for each cell with a non-default background. On a line with syntax-highlighted text, this might be 50+ individual `fillRect` calls.

**Target**: Scan each row left-to-right, accumulate runs of identical background color, and draw one `fillRect` per run. A fully colored line might go from 50 calls to 5-10.

**Combined with dirty tracking**: Only process dirty cells. If a run spans clean and dirty cells, extend the background rect but skip glyph drawing for clean cells.

---

### Step 2.4 — Multi-Layer Canvas Stack

**What**: Split rendering into three independent canvases stacked via CSS.

**Layer 0 — Text + Background** (bottom):
- The heaviest layer. Draws backgrounds and glyphs from the atlas
- Only redraws when cell content changes
- Candidate for OffscreenCanvas + Worker (Step 2.6)

**Layer 1 — Selection Overlay** (middle):
- Semi-transparent rectangles over selected cells
- Only redraws when selection changes (mousedown/mousemove during select)
- Extremely cheap to draw

**Layer 2 — Cursor** (top):
- Single rectangle/bar/underline at cursor position
- Redraws on cursor blink (~every 530ms) and cursor move
- The only layer that updates when nothing else is happening

**Why three layers**: Cursor blink currently triggers a full row redraw (because the cursor hash changes). With a dedicated cursor canvas, the blink cycle draws a single rectangle onto a tiny surface. The text layer is untouched. This alone eliminates the most frequent unnecessary redraw.

---

### Step 2.5 — High-DPI Rendering Overhaul

**What**: The current DPR handling is correct but minimal. Harden it for all cases.

**Current state**: `resize()` scales the canvas backing store by `window.devicePixelRatio` and applies `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`. This works on integer DPR (2x Retina).

**Additions needed**:
- **Fractional DPR** (1.25, 1.5, 1.75 on Windows): Pixel-snap cell boundaries to avoid subpixel blending artifacts. Round `cellWidth * dpr` and `cellHeight * dpr` to integers, then derive the logical cell size back.
- **DPR change detection**: When the window moves to a display with a different DPR, invalidate the glyph atlas (glyphs were rasterized at the old DPR) and resize all canvas layers. Use `matchMedia('(resolution: Xdppx)')` to detect this.
- **Atlas rasterization at physical pixels**: The glyph atlas should rasterize at `fontSize * dpr`, not `fontSize`. This ensures glyphs are crisp at the native resolution.

---

### Step 2.6 — OffscreenCanvas + Web Worker for the Text Layer

**What**: Move the text+background rendering to a Web Worker using `OffscreenCanvas`. The main thread handles only input events and lightweight cursor/selection layers.

**Architecture**:
```
Main Thread                          Render Worker
├─ Input events                      ├─ Owns OffscreenCanvas (text layer)
├─ Cursor canvas (direct draw)       ├─ Owns glyph atlas
├─ Selection canvas (direct draw)    ├─ Receives RenderState via postMessage
├─ TerminalCore                      ├─ Performs dirty-cell rendering
└─ Posts RenderState to worker       └─ drawImage blits from atlas
```

**Data transfer**: `RenderState` is posted to the worker. For the initial implementation, use structured clone (copies the data). Phase 4 will upgrade this to `SharedArrayBuffer` for zero-copy.

**Fallback**: If `OffscreenCanvas` is not supported (unlikely in modern WebViews, but defensive), fall back to main-thread rendering on the primary canvas.

**Why this matters**: `fillText()` (for cache misses) and `drawImage()` (for cache hits) block the main thread. In a worker, they block only the worker — the main thread remains responsive to keyboard input. This eliminates input latency spikes during heavy rendering.

---

### Step 2.7 — Frame Scheduling and Throughput Handling

**What**: Build an intelligent frame scheduler that adapts to workload.

**Current state**: `scheduleDraw()` uses a simple `requestAnimationFrame` gate — at most one draw per frame. This is correct but doesn't handle sustained high throughput.

**Target**:
- **Normal mode** (typing, small output): Render every frame that has dirty cells. Target <1ms incremental frame time.
- **High-throughput mode** (`cat huge_file.txt`, compilation output): Detect when `write()` is called multiple times between frames. Buffer all writes, process them through the parser, but only render the final state. The user sees the latest output, not every intermediate line.
- **Detection heuristic**: If `write()` was called N times since the last frame, and total bytes exceed a threshold (e.g., 64KB), enter high-throughput mode. Drop back to normal when write frequency decreases.
- **Frame skipping**: In high-throughput mode, skip rendering entirely for some frames (process data but don't draw). Render every Nth frame or when a quiet period is detected.

---

### Step 2.8 — Rendering Performance Measurement

**What**: Build intrinsic measurement into the renderer from the start.

**Metrics to track**:
- Frame time (rAF callback to callback)
- Draw time (start of `draw()` to end)
- Dirty cell count per frame
- Atlas cache hit/miss ratio
- Atlas page count and utilization
- Glyph rasterization time (cumulative per frame)

**Implementation**: A `RenderMetrics` object updated each frame, exposed via a debug overlay (toggle-able) that shows FPS, frame time, and cache stats. This isn't a luxury — it's the instrument panel for every optimization decision from here forward.

---

## Phase 3 — Terminal Emulation Core (Detailed Steps)

This phase makes the terminal correct. Phase 2 made it fast — but "fast at rendering the wrong thing" isn't useful. The current emulator handles the common cases (basic VT100, SGR colors, cursor movement, alt screen) but has significant gaps in Unicode handling, parser edge cases, and conformance.

The key insight from the research: **Unicode is not a feature you add later. It changes how cells are stored, how the cursor moves, how selection works, and how the renderer measures glyphs.** Every terminal that treated Unicode as an afterthought spent years refactoring. We're doing it now, on a small codebase, before the architecture calcifies.

---

### Step 3.1 — UAX #29 Grapheme Cluster Segmentation

**What**: Replace the current single-codepoint character model with proper grapheme cluster handling.

**Current state**: `Screen.print(char)` receives a single character (from the parser iterating `for (const ch of data)`) and writes it to one cell. This handles single codepoints but breaks on:
- Emoji with skin tone modifiers (👋🏽 = 2 codepoints, 1 grapheme, 2 cells wide)
- Emoji ZWJ sequences (👨‍👩‍👧 = 5+ codepoints, 1 grapheme, 2 cells wide)
- Combining marks (é = e + ◌́ = 2 codepoints, 1 grapheme, 1 cell)
- Regional indicators (🇺🇸 = 🇺 + 🇸 = 2 codepoints, 1 grapheme, 2 cells wide)

**Implementation**:
- Integrate a grapheme cluster segmentation library (or implement UAX #29 rules)
- The **parser** should not segment — it passes raw codepoints. The **screen** accumulates codepoints into grapheme clusters before writing to cells
- **Fast path**: ASCII bytes (0x20–0x7E) bypass segmentation entirely. This is the 99% case for terminal output and must have zero overhead.
- **Slow path**: Non-ASCII codepoints enter the grapheme segmenter, which buffers until a cluster boundary is detected, then writes the complete grapheme to the cell

---

### Step 3.2 — Grapheme-Aware Cell Storage

**What**: Redesign the `Cell` type to handle multi-codepoint graphemes without bloating the common case.

**Current state**: `Cell.char` is a `string`. Every cell allocates a JS string object. For a 120x40 terminal with scrollback, that's hundreds of thousands of string allocations.

**Target (Ghostty's pattern)**:
- **Inline storage** (the 99% case): Single codepoints stored as a number (the code point) directly in the cell. No string allocation.
- **Overflow storage** (multi-codepoint graphemes): A side `Map<number, string>` keyed by cell offset stores the full grapheme string. The cell stores a sentinel value indicating "look up in the overflow map."
- **Width stored in the cell**: Each cell knows its display width (1 or 2). Wide graphemes occupy 2 cells (primary + continuation), same as the current wide character model but generalized to graphemes.

**Migration**: This changes the `Cell` interface, which means `Screen`, `Renderer`, and `Selection` all need updates. Because Phase 1 created clean boundaries, the renderer only sees cells through `RenderState` — so the renderer changes are isolated to how it reads `char` from a cell.

---

### Step 3.3 — Grapheme Width Determination

**What**: Replace `isWideChar()` with a proper width function that handles graphemes.

**Current state**: `isWideChar()` checks Unicode ranges for East Asian Width. This is a reasonable approximation for CJK but fails on:
- Emoji (most are wide but not all — e.g., ♠ is narrow, 🃏 is wide)
- Variation selectors (U+FE0E text presentation = narrow, U+FE0F emoji presentation = wide)
- ZWJ sequences (variable width depending on renderer support)

**Target**:
- Use Unicode East Asian Width property as the base
- Layer emoji presentation rules on top (VS15/VS16)
- For ZWJ sequences: measure the rendered width when possible, fall back to "2 cells" as a reasonable default
- **Terminal-specific rule**: Width must be deterministic. The terminal and the application running inside it (vim, tmux) must agree on width. Follow the emerging `Mode 2027` convention (Kitty's width protocol) where possible.

---

### Step 3.4 — Parser Hardening

**What**: Fill the gaps in the VT parser for correctness and resilience.

**Current gaps**:
- **DCS passthrough**: Currently skips to ST. Real DCS sequences carry data (DECRQSS, Sixel, tmux control mode). Implement a `dcsDispatch(intermediates, params, data)` handler.
- **APC / PM strings**: Not handled at all. These should be consumed and silently discarded (or dispatched for future use).
- **C1 control codes** (0x80–0x9F): In UTF-8 mode these are legitimate character bytes, not controls. The parser currently doesn't distinguish. Add a mode flag for 7-bit vs 8-bit C1 handling.
- **Malformed sequences**: The parser is mostly robust (CAN/SUB abort, CsiIgnore for unexpected intermediates) but should be fuzz-tested with random binary data to find crashes or hangs.
- **Sub-parameter colons in SGR**: Currently treated as semicolons. Per the spec, `38:2:R:G:B` (colon-separated) and `38;2;R;G;B` (semicolon-separated) are different — colons are sub-parameters. Implement proper colon handling for SGR extended colors and underline styles (`4:3` for curly underline).

---

### Step 3.5 — Memory-Efficient Buffer Architecture

**What**: Redesign the buffer for memory efficiency without sacrificing access speed for the active screen.

**Current state**: Each cell is a JS object `{ char: string, fg: number, bg: number, attrs: number, ulColor: number }`. Each row is an `Array<Cell>`. This is readable but memory-heavy — a JS object has 40-80 bytes of overhead beyond its data.

**Target — Active Screen (fast random access)**:
- **Flat typed arrays** instead of object arrays. A row can be represented as:
  - `Uint32Array` for codepoints (or overflow indices)
  - `Uint32Array` for packed fg/bg colors
  - `Uint16Array` for attributes + underline color index
- Or a single `ArrayBuffer` per row with a stride per cell
- This eliminates GC pressure from thousands of small objects

**Target — Scrollback (compact, append-only)**:
- **Shared style table**: Most cells in scrollback share a small number of styles. Instead of storing fg/bg/attrs per cell, store a style index that references a shared table.
- **Compressed rows**: Scrollback rows that haven't been modified can be run-length encoded or stored as `{text: string, styles: [{start, end, styleIndex}]}`.
- **Memory budget**: With ref-counted styles and compressed text, scrollback should use ~50-100 bytes/row instead of ~2KB/row (120 cells × 16+ bytes/cell).

---

### Step 3.6 — Scroll Region and Margin Correctness

**What**: Harden scroll region behavior for edge cases that real TUI applications rely on.

**Current gaps to investigate and fix**:
- Origin mode (DECOM) interaction with scroll regions — cursor addressing should be relative to the scroll region when origin mode is active
- Scroll region preservation across alt screen switches
- Insert/delete lines at the boundaries of a scroll region
- Scrolling within a region that doesn't start at row 0 (used by tmux status bars, vim splits)
- Verify: when the scroll region is set, cursor movement (`CUU`/`CUD`) should be clamped to the region bounds only for scrolling, not for all movement

---

### Step 3.7 — Tab Stop Management

**What**: Implement full tab stop control.

**Current state**: Tab stops are initialized at every 8th column. `HTS` (set tab at cursor), `TBC` (clear tab stops), and `CHT`/`CBT` (cursor forward/backward tab) are not implemented.

**Target**:
- `ESC H` (HTS): Set a tab stop at the current cursor column
- `CSI 0 g` (TBC): Clear the tab stop at the current column
- `CSI 3 g` (TBC): Clear all tab stops
- `CSI n I` (CHT): Cursor forward N tab stops
- `CSI n Z` (CBT): Cursor backward N tab stops
- Tab stops survive across resize (adjust for new column count)

---

### Step 3.8 — Character Sets and Charset Designation

**What**: Implement the G0/G1/G2/G3 character set designation and invocation system.

**Current state**: `ESC ( B` and similar charset designations are received but ignored. `SO` (0x0E) and `SI` (0x0F) are no-ops.

**Why it matters**: Applications use DEC Special Graphics (line-drawing characters) via `ESC ( 0`. Without this, box-drawing in programs like `mc` (Midnight Commander), some `tmux` configurations, and older TUI apps renders as letters instead of lines.

**Target**:
- Support charset designation: `ESC ( 0` (DEC Special Graphics for G0), `ESC ( B` (ASCII for G0), and the G1/G2/G3 equivalents
- Implement `SO`/`SI` to switch between G0 and G1
- DEC Special Graphics mapping: translate characters `0x60–0x7E` to the Unicode box-drawing equivalents when the DEC graphics set is active
- This is a lookup table, not complex logic — but it must be correct

---

### Step 3.9 — Additional VT Sequences for TUI Compatibility

**What**: Implement the sequences that real TUI applications require but the current emulator is missing.

**Priority sequence groups**:
- **DECALN** ✓ (already implemented)
- **DECBI / DECFI** (back/forward index — used by some editors)
- **DECCRA** (copy rectangular area — used by some TUI frameworks)
- **REP** ✓ (already implemented)
- **DECSC/DECRC** ✓ (already implemented)
- **DECSTR** (soft terminal reset — less aggressive than RIS)
- **DECSCA** (select character protection attribute)
- **SM/RM additional modes**: Focus events (mode 1004), save/restore mode values (1048), synchronized output (2026 — already accepted)
- **OSC**: Window title push/pop (OSC 22/23), clipboard (OSC 52), hyperlinks (OSC 8), notification (OSC 9/777)

**Prioritization**: Focus events (1004) and OSC 52 (clipboard) are the highest priority — many modern CLI tools expect them.

---

### Step 3.10 — Conformance Testing Infrastructure

**What**: Integrate terminal conformance tests into the development workflow.

**Tools**:
- **vttest**: The classic VT100/VT220/VT420 conformance suite. Run it inside t-bias and verify output matches expected results.
- **esctest**: More comprehensive, tests VT100 through VT525. Can be run programmatically.
- **Custom test harness**: Write unit tests for `TerminalCore` (made possible by Phase 1's decoupling) that:
  1. Feed specific escape sequences in
  2. Assert cell contents, cursor position, and mode flags
  3. Can be run headlessly without a canvas or PTY

**The custom harness is the most valuable part**: It lets us write regression tests for every bug we fix and every edge case we discover. vttest/esctest validate visual output; the custom harness validates internal state.

**Example test structure**:
```
test("CUP moves cursor to specified position", () => {
  const core = new TerminalCore(80, 24);
  core.write("\x1b[5;10H");
  expect(core.cursorX).toBe(9);  // 0-indexed
  expect(core.cursorY).toBe(4);  // 0-indexed
});

test("SGR 38;2;R;G;B sets true color foreground", () => {
  const core = new TerminalCore(80, 24);
  core.write("\x1b[38;2;255;128;0mX");
  const cell = core.getCell(0, 0);
  expect(cell.fg).toBe(rgbColor(255, 128, 0));
});
```

---

### Step 3.11 — Real-World Application Testing

**What**: Test against the applications that actually matter — not just conformance suites.

**Test matrix** (ordered by complexity):
1. **Basic shell** (zsh/bash with prompts, completions, colors) — should work now
2. **tmux** — scroll regions, alt screen, status bar, pane splits, mouse forwarding
3. **vim/neovim** — alt screen, cursor shapes, SGR mouse, syntax highlighting, scrolling regions
4. **htop/btop** — rapid updates, color gradients, UTF-8 box drawing
5. **Claude Code** — complex TUI with heavy escape sequences, colors, cursor movement
6. **Midnight Commander** — DEC graphics (line-drawing), panels, dialog boxes
7. **git log --graph** — wide Unicode, color, long scrollback

Each application exercises a different subset of VT sequences. Document which sequences each one requires and use that as a prioritization guide for what to implement next.

---

## Phase Completion Criteria

### Phase 1 is complete when:
- `TerminalCore` can be instantiated and tested without any DOM or Canvas
- `IRenderer` interface exists and the Canvas renderer implements it
- Swapping the renderer requires changing zero lines in `TerminalCore`
- All current functionality works identically
- Multi-canvas DOM structure is in place (even if only one canvas is active)

### Phase 2 is complete when:
- Glyph atlas is operational with >95% cache hit rate during normal use
- Cell-level dirty tracking is live, with threshold-based full-redraw fallback
- Cursor blink does not trigger text layer redraws
- `cat /dev/urandom | head -10000` completes without UI freeze
- Frame time stays under 5ms for full redraws, under 0.5ms for incremental
- Debug overlay shows real-time rendering metrics

### Phase 3 is complete when:
- Emoji with skin tones, ZWJ sequences, and combining marks render correctly
- The grapheme-aware cell model is in place with inline/overflow storage
- vttest basic suite passes
- Custom test suite covers all implemented CSI, ESC, and OSC sequences
- tmux, vim, and htop work correctly inside t-bias
- Scrollback memory usage is measurably reduced vs the current object-per-cell model
