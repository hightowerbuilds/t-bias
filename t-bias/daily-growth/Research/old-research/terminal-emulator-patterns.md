# Terminal Emulator Architecture: Comprehensive Research

> Research compiled April 2026 to inform the creation of a world-class canvas-rendered terminal emulator.

---

## Table of Contents

1. [Part 1: Successful Build Patterns](#part-1-successful-build-patterns)
   - [Architectural Overview of Major Terminals](#architectural-overview-of-major-terminals)
   - [Rendering Strategies](#rendering-strategies)
   - [VT Parsing Approaches](#vt-parsing-approaches)
   - [Buffer and Scrollback Management](#buffer-and-scrollback-management)
   - [PTY Management Patterns](#pty-management-patterns)
   - [Unicode, Wide Characters, Grapheme Clusters, and Ligatures](#unicode-wide-characters-grapheme-clusters-and-ligatures)
   - [Threading and Concurrency Models](#threading-and-concurrency-models)
   - [Low-Latency Techniques](#low-latency-techniques)
   - [Input Handling Patterns](#input-handling-patterns)
2. [Part 2: Bottlenecks, Challenges, and Common Hurdles](#part-2-bottlenecks-challenges-and-common-hurdles)
   - [Hardest Problems in Terminal Emulation](#hardest-problems-in-terminal-emulation)
   - [Performance Bottlenecks](#performance-bottlenecks)
   - [Common Bugs and Failure Modes](#common-bugs-and-failure-modes)
   - [Difficult VT/ANSI Sequences](#difficult-vtansi-sequences)
   - [Modern Unicode Challenges](#modern-unicode-challenges)
   - [High-DPI Rendering](#high-dpi-rendering)
   - [Accessibility](#accessibility)
   - [Cross-Platform PTY Pain Points](#cross-platform-pty-pain-points)
   - [Conformance Testing](#conformance-testing)
   - [Image Protocols (Sixel, Kitty, iTerm2)](#image-protocols-sixel-kitty-iterm2)
   - [Font Fallback and Rendering](#font-fallback-and-rendering)
   - [Memory Management with Large Scrollback](#memory-management-with-large-scrollback)
3. [Part 3: Lessons from Open Source](#part-3-lessons-from-open-source)
   - [xterm.js: DOM to Canvas to WebGL](#xtermjs-dom-to-canvas-to-webgl)
   - [Alacritty: What Made It Fast and Its Limitations](#alacritty-what-made-it-fast-and-its-limitations)
   - [Kitty: Protocol Innovations](#kitty-protocol-innovations)
   - [WezTerm: The Multiplexer Approach](#wezterm-the-multiplexer-approach)
   - [Ghostty: Modern Architecture](#ghostty-modern-architecture)
   - [Hyper: Lessons from Electron](#hyper-lessons-from-electron)
   - [Architectural Mistakes and Corrections](#architectural-mistakes-and-corrections)
4. [Actionable Recommendations for a Canvas-Rendered Terminal](#actionable-recommendations-for-a-canvas-rendered-terminal)

---

## Part 1: Successful Build Patterns

### Architectural Overview of Major Terminals

#### Alacritty (Rust, OpenGL ES 2.0)

Alacritty's architecture is organized around a **central event loop** that coordinates between window management, terminal emulation, and rendering. The codebase is a Cargo workspace with separate crates: `alacritty` (main binary), `alacritty_terminal` (terminal emulation logic), and `alacritty_config` (configuration). This modular separation means `alacritty_terminal` can be used as a standalone library.

Alacritty's design philosophy prioritizes three values in order: **correctness, performance, simplicity**. It deliberately excludes tabs, splits, and GUI configuration, delegating those to window managers and tmux. This minimalism is architectural -- it keeps the rendering path simple and the memory footprint small (~8MB baseline).

Sources: [Announcing Alacritty](https://jwilm.io/blog/announcing-alacritty/), [Alacritty DeepWiki](https://deepwiki.com/alacritty/alacritty)

#### Kitty (C + Python, OpenGL)

Kitty is a GPU-accelerated terminal using OpenGL with SIMD vector CPU instructions. It pioneered several protocol extensions (graphics protocol, keyboard protocol) and uses a **threaded rendering model** to minimize input latency. Written primarily in C for the performance-critical core with Python for extensions ("kittens"), Kitty achieves a balance between raw speed and extensibility.

Source: [Kitty Documentation](https://sw.kovidgoyal.net/kitty/)

#### WezTerm (Rust, OpenGL/Metal)

WezTerm is organized as a **Cargo workspace with 19+ member crates**, each focused on a specific subsystem. The key architectural innovation is the **separation of terminal emulation from the GUI** through a multiplexer layer. The hierarchy is:

- `wezterm-term`: Platform-agnostic terminal emulation
- `mux`: Session management (windows > tabs > panes in a binary tree)
- `wezterm-gui`: GPU-accelerated rendering frontend

This separation enables: headless operation via `wezterm-mux-server`, remote access through a codec-based RPC protocol (PDU-framed with leb128 encoding + bincode serialization), and hot-swappable GUI attachments without session loss.

Source: [WezTerm DeepWiki](https://deepwiki.com/wezterm/wezterm), [WezTerm Multiplexer Architecture](https://deepwiki.com/wezterm/wezterm/2.2-multiplexer-architecture)

#### Ghostty (Zig, OpenGL/Metal)

Ghostty uses a **multi-threaded architecture with a dedicated read thread, write thread, and render thread per terminal surface**. The core is `libghostty`, a cross-platform, zero-dependency C/Zig library that can be used to build other terminal emulators.

Platform-native UI: macOS uses Swift/AppKit/SwiftUI, Linux uses GTK4 via Zig's C interop. Both interface with the shared `libghostty` core. A `Surface` represents a single terminal instance and owns a Terminal, Termio, and Renderer.

Source: [About Ghostty](https://ghostty.org/docs/about), [Ghostty DeepWiki](https://deepwiki.com/ghostty-org/ghostty)

#### Windows Terminal (C++, Direct3D 11)

Windows Terminal's **Atlas Engine** is the primary rendering engine. It implements two backends:

- **BackendD3D**: High-performance backend requiring Direct3D 11.0+ with compute shaders. Uses DirectWrite/Direct2D only for glyph rasterization, then places glyphs via Direct3D with HLSL shaders.
- **BackendD2D**: Fallback for older hardware or WARP (software) adapters.

The viewport is divided into cells stored as a simple matrix. `QuadInstance` represents a single renderable element (glyph, cursor, background rect) containing position, size, texture coordinates, and color.

Source: [Atlas Engine DeepWiki](https://deepwiki.com/microsoft/terminal/3.2-atlas-engine), [Windows Terminal Text Rendering Revamp](https://visualstudiomagazine.com/articles/2022/02/07/windows-terminal-1-13.aspx)

#### xterm.js (TypeScript, DOM/Canvas/WebGL)

xterm.js follows a strict **three-layer architecture**:

1. **Foundation**: Platform-agnostic escape sequence parser state machine, buffer data structures, dependency injection
2. **Core Terminal Logic**: CoreTerminal, InputHandler, BufferService, OptionsService
3. **Browser Integration**: DOM manipulation, rendering coordination, viewport scrolling, input, accessibility

An `IRenderer` abstraction allows different rendering backends (DOM, Canvas, WebGL) to coexist.

Source: [xterm.js DeepWiki](https://deepwiki.com/xtermjs/xterm.js/1-overview)

#### iTerm2 (Objective-C/Swift, Metal)

iTerm2 version 3.2 introduced a Metal drawing engine for GPU-accelerated text rendering. The Metal renderer handles subpixel antialiasing with a complex blending algorithm. It trades higher energy consumption for significantly faster screen updates.

Source: [iTerm2 Metal Renderer Wiki](https://gitlab.com/gnachman/iterm2/-/wikis/Metal-Renderer)

#### Hyper (TypeScript/Electron, WebGL via xterm.js)

Hyper treats itself as a web app first and a terminal second. Built on Electron with React, Redux, and xterm.js. Runs as three separate processes: Main Process (window management + PTY), Renderer Process, and Plugin host. The DOM-based rendering in early versions was extremely slow; subsequent versions migrated to canvas and then WebGL.

Source: [Hyper Architecture](https://readoss.com/en/vercel/hyper/hypers-architecture-navigating-electron-terminal-emulator-codebase)

#### Foot (C, CPU-rendered for Wayland)

Foot is a fast, minimal Wayland-native terminal that achieves excellent performance **without GPU acceleration**. It uses a **server/client architecture**: a persistent server process handles rendering, font management, and Wayland communication; `footclient` connects to it, sharing fonts and glyph cache for near-instant startup and minimal per-window memory overhead.

Source: [Foot Repository](https://codeberg.org/dnkl/foot)

---

### Rendering Strategies

#### The Texture Atlas Pattern (Universal)

Every major GPU-accelerated terminal uses the same fundamental pattern:

1. **Glyph Rasterization**: Characters are rasterized from vector fonts (TrueType/OpenType) into bitmaps using FreeType, CoreText, or DirectWrite -- **once per unique glyph**.
2. **Atlas Storage**: Rasterized bitmaps are packed into a GPU texture (the "atlas"). This is a single large texture containing all needed glyphs.
3. **Instance Data Upload**: Per-frame, a buffer of instance data (position, texture coordinates, color) is uploaded to the GPU. Each visible cell maps to one entry.
4. **Draw Calls**: The GPU renders all glyphs in minimal draw calls (Alacritty achieves **two draw calls per frame**: one for background colors, one for glyphs).

**Alacritty specifics**: OpenGL ES 2.0 via `winit` (windowing) and `glow` (OpenGL loader). The renderer achieves ~500 FPS on a full screen of text, with only ~2ms per frame spent in the renderer. State changes are minimized aggressively.

**xterm.js WebGL specifics**: Builds a `Float32Array` with all drawing data, uploads via vertex/fragment shaders. Uses multiple 512x512 atlas textures (not one giant texture) for faster GPU upload, merging up to 4096x4096 max. A packing strategy uses multiple active rows, placing glyphs in the most suitable row by pixel height.

**Windows Terminal specifics**: HLSL shader pipeline -- vertex shader transforms quad instances from cell coordinates to screen space; pixel shader handles text blending (Grayscale/ClearType), built-in glyph generation, and line rendering.

Sources: [Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases), [xterm.js WebGL PR](https://github.com/xtermjs/xterm.js/pull/1790)

#### Zutty: The Compute Shader Approach

Zutty takes a radically different approach using **OpenGL ES 3.1 compute shaders**:

- Terminal cells are stored directly in GPU memory as a Shader Storage Buffer Object (SSBO)
- The virtual terminal manipulates the array directly via a mapping into process address space
- Each screen update dispatches a compute program over the grid (nCols x nRows)
- Each compute instance retrieves its cell via `GlobalInvocationID`
- Delta-copying with per-cell dirty flags allows compute instances to skip unchanged cells, reducing GPU work by **10x+** in typical use
- Image rendering is zero-cost from the CPU perspective

Source: [How Zutty Works](https://tomscii.sig7.se/2020/11/How-Zutty-works)

#### Canvas 2D vs WebGL (Web Context)

For web-based terminals, the progression is clear:

| Renderer | Speed | CPU Load | Scalability | Notes |
|----------|-------|----------|-------------|-------|
| DOM | Slowest | High | Poor at large viewports | Flexible CSS styling |
| Canvas 2D | Medium | Medium | Degrades with wide containers | Simpler API |
| WebGL | Fastest | Low | Scales well | Average frame time <1ms |

WebGL rendering is **3-5x faster** than Canvas in benchmarks. Canvas glyphs are restricted because drawing/invalidating is expensive; WebGL redraws every character every frame, which is paradoxically cheaper because the GPU handles it in parallel.

However, Canvas 2D can outperform WebGL on specific platforms (e.g., macOS/Chrome where Canvas 2D rendered ~20% more images than WebGL at 60 FPS), suggesting **performance depends on OS, browser, and GPU driver**.

Source: [VS Code Terminal Renderer Author on HN](https://news.ycombinator.com/item?id=27131659), [2D vs WebGL Canvas Performance](https://semisignal.com/a-look-at-2d-vs-webgl-canvas-performance/)

#### Platform-Native GPU APIs

| Terminal | macOS | Linux | Windows |
|----------|-------|-------|---------|
| Alacritty | OpenGL ES 2.0 | OpenGL ES 2.0 | OpenGL ES 2.0 |
| Kitty | OpenGL | OpenGL | N/A |
| WezTerm | Metal | OpenGL | Direct3D |
| Ghostty | Metal | OpenGL | N/A (planned) |
| Windows Terminal | N/A | N/A | Direct3D 11 |
| iTerm2 | Metal | N/A | N/A |

---

### VT Parsing Approaches

#### The Paul Williams State Machine (Industry Standard)

The definitive reference is the **Paul Williams ANSI-compatible parser** at [vt100.net](https://vt100.net/emu/dec_ansi_parser). Nearly every modern terminal bases its parser on this specification:

- **14 states**: Ground, Escape, EscapeIntermediate, CsiEntry, CsiParam, CsiIntermediate, CsiIgnore, DcsEntry, DcsParam, DcsIntermediate, DcsPassthrough, DcsIgnore, OscString, SosPmApcString
- **Actions on transitions**: Print, Execute, Hook, Put, Unhook, OscStart, OscPut, OscEnd, Collect, Param, Clear, Dispatch (CsiDispatch, EscDispatch)
- **Error recovery**: The state machine is designed to recover from malformed sequences by returning to Ground state

#### Implementation Approaches

**Table-driven (Alacritty `vte` crate):**
The `vte` crate implements the Paul Williams state machine using **procedural macros to generate lookup tables** at compile time. A high-level state machine definition is translated into low-level lookup tables with very little branching. The `advance()` method processes one byte at a time, dispatching to a `Perform` trait implementation. The parser itself assigns no meaning to data -- separation of parsing from semantics.

```
// Conceptual flow:
byte -> lookup_table[state][byte] -> (new_state, action)
action -> Perform::csi_dispatch() / Perform::esc_dispatch() / etc.
```

Source: [Alacritty vte crate](https://github.com/alacritty/vte), [vte DeepWiki](https://deepwiki.com/alacritty/vte)

**SIMD-optimized (Kitty, Ghostty):**

Kitty implemented a **SIMD-vectorized escape code parser** using AVX2/SSE 4.2 (x86) or NEON (ARM) instructions. Results:

| Data Type | Kitty SIMD Throughput |
|-----------|-----------------------|
| ASCII chars | 115.7 MB/s |
| Unicode chars | 99.5 MB/s |
| CSI codes (few chars) | 56.7 MB/s |
| Long escape codes | 327.9 MB/s |

Speedups of **50% to 400%** over the previous parser. The implementation restricts to AVX2 maximum (no AVX-512) to avoid energy/warm-up penalties and to support efficiency cores.

Ghostty's `libghostty-vt` provides a standalone DFA state machine processing ANSI/VT sequences at **>100 MB/s** through SIMD. It uses SIMD for both escape sequence parsing and multi-byte UTF-8 decoding. A CSI fast-path optimization improved ASCII processing by **2.5x** and Japanese text by **1.5x**. Real-world throughput (measured against 4GB of asciinema recordings) improved **2x-5x** depending on UTF-8 complexity.

Sources: [Kitty SIMD Parser RFC](https://github.com/kovidgoyal/kitty/issues/7005), [Ghostty Devlog 006](https://mitchellh.com/writing/ghostty-devlog-006)

**Streaming vs Buffered:**
All high-performance parsers use **streaming** -- bytes are processed as they arrive from the PTY, one at a time through the state machine, with actions dispatched immediately. There is no buffering of the entire PTY output before parsing. However, rendering is typically decoupled: parsed content updates an internal buffer, and rendering happens on a separate cadence (frame-based or damage-triggered).

---

### Buffer and Scrollback Management

#### Screen Buffer Architecture

The terminal screen is typically stored as a 2D grid of cells. Each cell contains:
- A character (codepoint or grapheme reference)
- Foreground color
- Background color
- Attributes (bold, italic, underline, blink, inverse, strikethrough, etc.)
- Flags (wide character, part of wide character, wrapped line, etc.)

**Per-cell memory cost** is a critical design decision. A naive approach with a full struct per cell can consume **12+ bytes per cell** -- even blank cells at the end of lines. For a 200-column, 10,000-line scrollback, that's 24MB per terminal.

#### Ghostty's Page-Based Architecture (State of the Art)

Ghostty uses a **doubly-linked list of memory pages** (the `PageList`):

- Each page is a single contiguous, page-aligned memory block
- Contains rows of cells plus supporting data (styles, hyperlinks, grapheme data)
- **Offset-based addressing**: All internal pointers stored as offsets from base, enabling serialization and memory movement without pointer fixup
- **Shared styles/hyperlinks**: Ref-counted sets, shared across cells within a page
- **Grapheme storage**: Multi-codepoint graphemes stored outside cells via a `grapheme_map` (maps cell offsets to codepoint slices in a bitmap allocator). Single-codepoint characters (the common case) are stored inline for speed.
- **Default page capacity**: Configurable, tuned for 64 styles, 4 hyperlinks, 1024 grapheme bytes, 1024 string bytes
- **Memory pool**: Pages pulled from a pool to avoid constant mmap syscalls. Standard pages recycled; non-standard (oversized) pages freed directly.

**The memory leak lesson**: Ghostty had a significant memory leak where non-standard pages (allocated for lines with many emoji/styles/hyperlinks) were improperly recycled into the standard-size pool during scrollback pruning. The metadata was resized to standard, but the underlying mmap allocation wasn't -- causing leaked memory that was never munmapped. Fix: never reuse non-standard pages; destroy and allocate fresh.

Source: [Finding and Fixing Ghostty's Largest Memory Leak](https://mitchellh.com/writing/ghostty-memory-leak-fix)

#### Scrollback Storage Strategies

| Strategy | Used By | Pros | Cons |
|----------|---------|------|------|
| Circular buffer (ring buffer) | Most terminals, Alacritty | Simple, O(1) append/prune | Fixed capacity, whole-line granularity |
| Linked list of pages | Ghostty | Flexible sizing, good locality | Pool management complexity |
| Compressed scrollback | VTE (GNOME Terminal) | Very memory-efficient | CPU cost on access |
| Disk-backed scrollback | VTE, Konsole (infinite mode) | Unlimited history | I/O latency, security concerns |
| Pre-allocated flat buffer | Simple terminals (st) | Minimal overhead | Wastes space on sparse content |

**VTE (GNOME Terminal)** stores scrollback on disk, compressed and encrypted. Konsole keeps finite scrollback in memory but places infinite scrollback on disk unencrypted. The compression approach is notable: since scrollback lines are never modified, they can be stored in a compact format that doesn't need random-write access.

**Key insight**: The active screen buffer and the scrollback buffer have fundamentally different access patterns. The active screen needs fast random read/write; the scrollback only needs append and sequential read. Designing for this asymmetry (e.g., rich structs for active screen, compressed format for scrollback) is the winning pattern.

---

### PTY Management Patterns

#### Unix PTY Architecture

A pseudo-terminal (PTY) consists of a **master/slave pair**:
- The **master side** is held by the terminal emulator, used for reading output and writing input
- The **slave side** is connected to the shell/child process's stdin/stdout/stderr
- The kernel mediates between them, handling line discipline, signal generation, etc.

#### Cross-Platform Abstraction (portable-pty)

WezTerm's `portable-pty` crate provides the gold-standard cross-platform PTY abstraction:
- **Unix**: Uses `openpty()`, `posix_spawn()` or `fork()`/`exec()`
- **macOS**: Same as Unix, with CoreFoundation integration
- **Windows**: Uses **ConPTY** (`CreatePseudoConsole`, `AttachPseudoConsole`) with named pipes

The trait-based design allows runtime selection of implementation:
```
PtySystem -> CommandBuilder -> Child + MasterPty + SlavePty
```

Source: [portable-pty docs](https://docs.rs/portable-pty)

#### Best Practices

1. **Non-blocking I/O**: Use `poll`/`epoll`/`kqueue` on the master FD. The `mio` crate is excellent for this in Rust.
2. **Background read thread**: Never block the UI thread on PTY reads. Dedicate a thread (Ghostty) or use async I/O (WezTerm).
3. **Kill before drop**: Always send SIGHUP/SIGTERM to the child process before closing the PTY to avoid zombie processes.
4. **Resize handling**: Respond to window resize by calling `ioctl(fd, TIOCSWINSZ, &winsize)` on the master. The kernel delivers SIGWINCH to the child.
5. **Environment setup**: Set TERM, COLORTERM, TERM_PROGRAM correctly. Kitty's SSH kitten demonstrates the complexity of remote environment setup (transmits a compressed tarball of shell integration scripts over the TTY).

#### Windows ConPTY Challenges

Windows ConPTY is fundamentally different from Unix PTY. It is essentially **its own terminal emulator** sitting between the user's terminal emulator and spawned applications, needed for backward compatibility with Windows console API programs. Key challenges:
- Named pipe-based communication instead of file descriptors
- Signal handling and process lifecycle management differ significantly
- CJK input method handling (cursor positioning, candidate windows, composition state) behaves differently
- Some edge cases with surprising behavior remain

Source: [WezTerm PTY Management DeepWiki](https://deepwiki.com/wezterm/wezterm/4.5-pty-and-process-management)

---

### Unicode, Wide Characters, Grapheme Clusters, and Ligatures

#### The Width Problem

Terminal emulators must determine how many fixed-width cells each character occupies. This is deceptively difficult:

**`wcwidth()` is broken for modern Unicode.** The POSIX `wcwidth()` function takes a single 32-bit codepoint and returns 1 or 2. This fails for:
- Multi-codepoint grapheme clusters (emoji ZWJ sequences like "family" emoji)
- Variation selectors (VS15 for text presentation, VS16 for emoji presentation)
- Combining characters and marks

Example: The farmer emoji (U+1F9D1 U+200D U+1F33E) is three codepoints. `wcwidth()` returns 2, 0, 2 respectively = 4 cells. The correct answer is 2 cells (one emoji-width glyph).

Source: [Mitchell Hashimoto: Grapheme Clusters in Terminals](https://mitchellh.com/writing/grapheme-clusters-in-terminals)

#### Grapheme Cluster Segmentation

**Unicode Text Segmentation (UAX #29)** defines grapheme cluster boundaries. Terminal emulators must implement this algorithm to correctly identify user-perceived characters.

Performance consideration: Grapheme cluster segmentation is computationally expensive but can be optimized for the terminal's common case (mostly ASCII). An optimized implementation adds almost no penalty for ASCII-heavy content while correctly handling complex Unicode.

**Ghostty scored highest** among all terminals tested for Unicode correctness in 2025 testing.

Source: [State of Terminal Emulators 2025](https://www.jeffquast.com/post/state-of-terminal-emulation-2025/)

#### The Multiplexer Problem

Terminal multiplexers (tmux, zellij) sit between applications and the terminal emulator. If tmux uses `wcwidth()` and the terminal uses grapheme clusters, their width calculations disagree, causing **cursor desynchronization**. This is one of the most persistent bugs in terminal ecosystems.

#### Ligatures in Monospace Fonts

Font ligatures (e.g., `->` becoming an arrow in Fira Code) create a tension with the fixed-width grid:

1. Text is segmented into **TextRuns** (sequences of cells sharing render properties)
2. Each TextRun is shaped by HarfBuzz, which returns glyph indices
3. Ligature glyphs must be rendered as if they still occupy their individual cells
4. The shaped glyph is drawn spanning multiple cells while maintaining cell alignment

Implementation: Change the base rendering unit from individual cells to TextRuns. This is how WezTerm, Kitty, and Contour handle it.

Source: [WezTerm Font Shaping](https://wezterm.org/config/font-shaping.html), [Font Shaping Ligature Support Gist](https://gist.github.com/XVilka/070ed8b1c1186097cad65ef49220175a)

#### BiDi (Bidirectional Text)

Bidirectional text rendering is **rarely implemented and extremely complex**:
- The Unicode BiDi algorithm must run on entire paragraphs, potentially including offscreen lines
- Window resizing requires re-running the algorithm
- Arabic text needs complex font shaping on a fixed-width grid (nearly impossible to do well)
- Paragraph direction must be externally specified (no reliable auto-detection)
- Only Konsole and VTE-based terminals have meaningful BiDi support (VTE via `\e[?2501h`)

A Terminal Complex Script Support Working Group (TCSS WG) was approved by Unicode Technical Committee #175, led by Microsoft.

Source: [BiDi in Terminal Emulators](https://terminal-wg.pages.freedesktop.org/bidi/)

---

### Threading and Concurrency Models

#### Ghostty: Three Threads Per Surface

| Thread | Responsibility |
|--------|---------------|
| **Read Thread** | Reads PTY output, runs SIMD-optimized parser, updates terminal state |
| **Write Thread** | Sends input to PTY |
| **Render Thread** | Renders terminal state to screen via OpenGL/Metal |

This maximizes parallelism: input is never blocked by rendering, and rendering is never blocked by parsing.

#### Contour: Multi-threaded with Message Passing

- **Main thread**: Receives user input (via GLFW3), displays screen updates
- **PTY thread**: Exclusively reads application output, updates internal terminal state
- **VT stream is parsed on the PTY thread**, which then signals the main thread for rendering
- Input events are mapped to VT sequences via `InputGenerator` and transmitted to the slave application

Source: [Contour Internals](https://contour-terminal.org/internals/)

#### Alacritty: Event Loop

Alacritty uses a **single-threaded event loop** with winit for window events. PTY I/O is handled via mio (non-blocking). The event loop processes: window events, PTY output, configuration changes, and triggers rendering.

#### Foot: Single-threaded Multiplexing

Foot runs entirely single-threaded with event-driven multiplexing. The server/client architecture shares resources (fonts, glyph cache) across all terminal windows. Trade-off: a single overloaded window can slow all windows; a server crash loses everything.

#### Key Insight for Our Project

**The three-thread-per-surface model (Ghostty) is the gold standard** for low latency. However, for a web/canvas context (Tauri), the threading model must account for:
- The main thread owns the DOM/Canvas and must not block
- Web Workers can handle PTY reading and parsing
- `OffscreenCanvas` or similar can enable render-thread separation
- Message passing between threads must be efficient (SharedArrayBuffer, transferable objects)

---

### Low-Latency Techniques

#### Latency Targets

| Response Time | User Perception |
|---------------|-----------------|
| 1ms | Ideal (Microsoft Research target) |
| 10ms | Acceptable (GNOME HIG) |
| 20ms | Feels fine |
| 50ms | Feels laggy |
| 150ms | Feels unbearable |

Source: [Dan Luu: Terminal Latency](http://danluu.com/term-latency/), [Terminal Latency beuke.org](https://beuke.org/terminal-latency/)

#### Techniques That Work

1. **Separate input processing from rendering**: If rendering blocks on GPU buffer swaps, input handling on the same thread will stall. Move rendering to its own thread so keypresses are sent to the PTY immediately.

2. **Damage tracking**: Maintain a dirty region (range of cell indexes) bounding what changed. In interactive use (typing into a shell), only a few contiguous cells change per frame. Avoids full-screen redraws. Zutty achieves **~6.5ms latency with 0.5ms std dev** using damage tracking.

3. **Frame skipping**: When throughput is too high (e.g., `cat huge_file.txt`), skip rendering intermediate frames. Only render the latest state. This prevents the renderer from falling behind.

4. **Adaptive latency**: Tune the delay between receiving PTY output and rendering. Lower values = lower latency but more frequent redraws (higher GPU usage). Higher values = better throughput but perceptible lag. The `st` terminal defaults to 2ms minlatency.

5. **Swap buffer damage**: Use `EGL_EXT_swap_buffers_with_damage` (or equivalent) to tell the compositor only the changed region, reducing compositing overhead. Alacritty's implementation of this noticeably improved typing latency. Combined with `EGL_EXT_buffer_age`, this can avoid `glClear` before every frame.

6. **GPU-resident state**: Zutty stores cells directly in GPU SSBO, avoiding CPU-to-GPU data transfer for unchanged cells.

Source: [Kitty Frame Damage Tracking](https://github.com/kovidgoyal/kitty/issues/3898), [Zutty Latency Commit](https://github.com/tomscii/zutty/commit/471cc60)

---

### Input Handling Patterns

#### The Legacy Problem

Traditional terminal input encoding has fundamental ambiguities:
- `Ctrl+I` and `Tab` both send `0x09`
- `Ctrl+M` and `Enter` both send `0x0D`
- `Escape` and the start of any escape sequence both begin with `0x1B`
- Many modifier combinations (Alt, Ctrl+Alt, Super) are lost or mangled
- No way to distinguish press/repeat/release events
- No support for modern modifiers (Hyper, Meta, Caps/Num lock state)

Source: [Your Terminal Can't Tell Shift+Enter from Enter](https://blog.fsck.com/releases/2026/02/26/terminal-keyboard-protocol/)

#### The Kitty Keyboard Protocol (Solution)

Kitty's protocol uses **structured CSI u sequences** that unambiguously encode:
- Physical key code (Unicode codepoint or special key number)
- All active modifiers (Shift, Ctrl, Alt, Super, Hyper)
- Event type (press, repeat, release)

Applications opt in by requesting enhanced mode. Example: with disambiguation enabled, `Ctrl+I` and `Tab` produce unique sequences (`KEY_CTRL_I` vs `KEY_TAB`).

**Adoption status (2026)**: Supported by Kitty, WezTerm, Foot, Alacritty, iTerm2, Rio, Ghostty, and Windows Terminal Preview (1.25+).

Source: [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), [WezTerm Key Encoding](https://wezterm.org/config/key-encoding.html)

---

## Part 2: Bottlenecks, Challenges, and Common Hurdles

### Hardest Problems in Terminal Emulation

1. **Unicode width determination**: No single authoritative source for character widths. Unicode.org data files contain contradictory categorizations. The consortium explicitly states there is no good way to derive run-widths from Unicode information alone.

2. **Escape sequence conformance**: ANSI X3.64-1979 defines many implementation-dependent features and error conditions without specifying recovery procedures. Different terminals handle malformed sequences differently, creating an ecosystem of subtle incompatibilities.

3. **The latency-throughput tradeoff**: Optimizing for low input latency (frequent rendering) directly conflicts with optimizing for high throughput (batch rendering). No terminal has perfectly solved this -- all use adaptive heuristics.

4. **Complex script rendering on a fixed grid**: Scripts like Arabic (cursive), Devanagari (complex combining), Tibetan, and Mongolian (vertical) are fundamentally incompatible with monospace cell grids.

5. **Cross-terminal-multiplexer width agreement**: When tmux and the outer terminal disagree on character widths, cursors desynchronize and the display corrupts. No universal solution exists yet.

---

### Performance Bottlenecks

#### Where Terminals Get Slow

1. **Parsing**: The parser itself is rarely the bottleneck in modern terminals (SIMD parsers hit 100+ MB/s). The bottleneck is in the **semantic processing** -- applying parsed sequences to the terminal state (cursor movement, scrolling, style changes).

2. **Rendering**: Full-screen redraws are expensive. Without damage tracking, every frame redraws every cell. On 4K displays with 200+ columns and 50+ rows, that is 10,000+ quads per frame. The solution is dirty-region tracking.

3. **Scrollback**: Large scrollback buffers (100,000+ lines) consume significant memory and can slow down search operations. VTE's disk-backed approach trades I/O latency for memory.

4. **Font rendering**: Loading non-Latin font pages and handling Unicode outside the BMP can cause dramatic slowdowns (Terminal.app is notably bad at this). Async font fallback resolution (WezTerm) prevents blocking.

5. **Non-Latin Unicode**: Terminal.app slows dramatically when outputting non-Latin Unicode ranges due to font page loading, BMP-external codepoint parsing, and wide character handling.

Source: [LWN Terminal Emulators Part 2](https://lwn.net/Articles/751763/)

#### Throughput Benchmarks

The traditional "speed" benchmark measures how fast a terminal can scroll by displaying large text. Modern terminals using SIMD parsing and GPU rendering handle this well, but the **rendering cadence** is the real differentiator -- how intelligently the terminal decides when to render vs. when to skip frames.

---

### Common Bugs and Failure Modes

1. **Terminal state corruption**: Stray `\033(0` (DEC alternate charset) sequences switch rendering to line-drawing characters. Without a matching `\033(B` to restore, all subsequent ASCII renders as box-drawing glyphs. Recovery requires explicit reset (`reset` command or `\033c`).

2. **Function key sequence conflicts**: Old Terminator generates faulty `SS3 1; modifiers char` sequences for F1-F4 with modifiers (copied from GNOME Terminal). XTerm's cursor position and F3 key sequences can collide.

3. **Escape sequence termination ambiguity**: An escape sequence can sometimes end with multiple different characters. Different terminals handle this differently, leading to subtle rendering differences.

4. **Inconsistent Home/End keys**: Linux VT sends `CSI 1~` / `CSI 4~`; Mac/PC standard is `CSI H` / `CSI F`. Applications must handle both.

5. **Security vulnerabilities**: Escape sequences that cause terminals to echo back data can be exploited for code execution. Historical attacks used title-setting sequences that were echoed back to the terminal input.

Source: [Julia Evans: Escape Code Standards](https://jvns.ca/blog/2025/03/07/escape-code-standards/), [G-Research: Terminal Escapes](https://www.gresearch.com/news/g-research-the-terminal-escapes/)

---

### Difficult VT/ANSI Sequences

#### Sequence Types by Complexity

| Type | Structure | Difficulty | Notes |
|------|-----------|------------|-------|
| **CSI** (Control Sequence Introducer) | `ESC [` params final | Medium | Most common; parameters can be complex |
| **OSC** (Operating System Command) | `ESC ]` id `;` data `ST` | Medium-High | String-valued; used for titles, colors, clipboard, hyperlinks |
| **DCS** (Device Control String) | `ESC P` params data `ST` | High | Combines CSI-like parameters with string data; used for Sixel, DECRQSS |
| **APC** (Application Program Command) | `ESC _` data `ST` | Medium | Used for Kitty graphics protocol |

**OSC complications**: Due to historical reasons, OSC sequences can be terminated by either BEL (0x07) or ST (ESC \\ or 0x9C). Ghostty echoes back whichever terminator was used for maximum compatibility.

**DCS complexity**: DCS has the most complex structure -- the first part mirrors a CSI sequence (parameters + intermediates + final character), then the rest is function-specific string data. Implementing DECRQSS (request status string), Sixel, and DECSIXEL correctly requires handling this dual structure.

Source: [Ghostty VT Concepts](https://ghostty.org/docs/vt/concepts/sequences), [VT510 Reference](https://vt100.net/docs/vt510-rm/chapter4.html)

---

### Modern Unicode Challenges

#### Emoji ZWJ Sequences

A family emoji like "Woman, Man, Girl, Boy" consists of multiple codepoints joined by Zero-Width Joiners (U+200D). The terminal must:
1. Identify the entire sequence as one grapheme cluster
2. Determine it should occupy 2 cells
3. Render a single glyph spanning those cells
4. Handle cursor movement correctly (left/right arrows skip the entire cluster)

#### Variation Selectors

VS15 (U+FE0E) forces text presentation; VS16 (U+FE0F) forces emoji presentation. A terminal must track these per-character and use the correct font/rendering path. Many terminals ignore variation selectors entirely.

#### The Mode 2027 Proposal

Mode 2027 is a proposal from the Contour terminal author for grapheme cluster support. It introduces a mode that terminals can enable to signal they handle grapheme clusters correctly, allowing applications to send multi-codepoint characters without worrying about width calculation mismatches.

#### Kitty's Width Protocol

Kitty (v0.40+) introduced a protocol that **allows programs to control how many cells a character is rendered in**, solving the width problem at the protocol level rather than trying to compute it.

Source: [Contour Unicode Core](https://contour-terminal.org/vt-extensions/unicode-core/), [Terminal Unicode Core Spec](https://github.com/contour-terminal/terminal-unicode-core)

---

### High-DPI Rendering

#### Platform-Specific Challenges

- **macOS/Wayland**: No system-queryable DPI value. Instead, the system communicates a scaling factor. Standard density is fixed; the OS reports when displays are high-density.
- **Wayland fractional scaling**: The protocol only supports integer scaling factors natively. Compositors that support fractional scaling can cause blurry text. WezTerm allows specifying a DPI value to compensate.
- **GTK fractional scaling**: GTK 3 only supports fractional scaling for fonts, not widgets. Fractional scaling requires rendering at higher resolution and downscaling, increasing CPU/GPU load.
- **Multi-monitor**: Different monitors with different scaling factors cause font size mismatches. Terminals may need to re-rasterize the entire glyph atlas when moving between monitors.

#### Practical Impact

With High-DPI, **differential drawing must be disabled** because text is drawn at fractional pixel heights. This forces full-screen redraws, negating damage tracking optimizations.

The glyph atlas must be rasterized at the correct DPI -- a move from a 1x to a 2x display requires regenerating all cached glyphs, which can cause a visible stutter.

Source: [Windows Terminal High-DPI Issue](https://github.com/microsoft/terminal/issues/5320), [Foot DPI Issue](https://codeberg.org/dnkl/foot/issues/714)

---

### Accessibility

#### Fundamental Architecture Problem

Terminal emulators that use canvas/GPU rendering **do not expose content via standard accessibility APIs** (Windows UI Automation, macOS Accessibility, AT-SPI on Linux). Screen readers cannot access the text content.

xterm.js solves this with a **hidden accessible DOM layer** -- an invisible HTML representation of terminal content that screen readers can access, kept in sync with the visible canvas/WebGL rendering.

#### Content Structure Problems

- CLIs output **unstructured text** with no semantic markup
- Tabular data (e.g., `top`, `ls -l`) cannot be interpreted as tables by screen readers
- Help text and man pages are long unstructured blocks; screen reader users rely on HTML documentation instead
- Progress indicators are not accessible
- Scrolling through terminal output with a screen reader is difficult

Source: [Accessibility of Command Line Interfaces (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3411764.3445544)

#### Actionable Approach

For a canvas-rendered terminal, **maintain a parallel accessible text representation** (similar to xterm.js's approach). This hidden layer should:
- Expose terminal content via ARIA live regions for output changes
- Support ARIA grid/table roles for structured content
- Maintain cursor position information
- Support text selection via accessible APIs

---

### Cross-Platform PTY Pain Points

1. **ConPTY is a terminal emulator itself**: Windows ConPTY parses VT sequences and re-emits them, adding latency and potentially mangling sequences. It exists for backward compatibility with native Windows console apps.

2. **Signal handling differences**: Unix uses SIGHUP, SIGTERM, SIGWINCH delivered via the kernel. Windows has no equivalent mechanism through ConPTY.

3. **CJK IME (Input Method Editor)**: Cursor positioning, candidate window placement, and composition state behave differently across platforms. This is one of the hardest cross-platform issues.

4. **ConPTY performance**: Eclipse Terminal developers documented performance issues with ConPTY compared to Unix PTY.

5. **Process lifecycle**: Detecting child process exit, handling orphaned processes, and cleaning up resources differ significantly between Unix and Windows.

Source: [ConPTY Performance in Eclipse Terminal](https://kichwacoders.com/2021/05/24/conpty-performance-in-eclipse-terminal/)

---

### Conformance Testing

#### VTTEST

- Written 1983-85 by Per Lindberg, maintained by Thomas Dickey
- Tests VT100/VT220/xterm compatibility
- **Semi-automated**: Uses query/response sequences to check responses, but relies on a knowledgeable user to visually inspect test screens
- Covers: cursor movements, screen features, tab settings, color handling, character insertion/deletion
- Broader coverage than esctest (about twice as much)

#### ESCTEST

- Automated unit tests for terminal emulation
- Defines ideal behavior as "xterm, but without bugs in George's opinion" (George Nachman, iTerm2 author)
- Tests across five VT levels (VT100 to VT525), in both non-UTF-8 and UTF-8 configurations
- Originally from iTerm2 project, now maintained separately as `esctest2`

#### Unicode Conformance Testing

Jeff Quast maintains comprehensive Unicode conformance tests that measure terminal emulators' handling of:
- Zero-width characters and combining marks
- Wide characters and grapheme clusters
- Emoji sequences
- Variation selectors

Source: [VTTEST](https://invisible-island.net/vttest/), [esctest2](https://github.com/ThomasDickey/esctest2), [Terminal Emulators Unicode Battle Royale](https://www.jeffquast.com/post/ucs-detect-test-results/)

---

### Image Protocols (Sixel, Kitty, iTerm2)

#### Sixel

- Originally from DEC (1980s) for VT340 terminals
- Encodes images as bands of 6 vertical pixels per character position
- **Performance**: Not optimized for modern terminal emulators. Current methods are slow and quality is poor compared to newer protocols.
- **Security**: Complex parsing surface; fuzzing reveals vulnerabilities
- **Interaction with text**: Cursor positioning and scrolling after Sixel output are inconsistent across implementations
- **Color registers**: No standard way to query available color count
- **Adoption**: Slowly growing; [arewesixelyet.com](https://www.arewesixelyet.com/) tracks support

#### Kitty Graphics Protocol

- Modern, flexible protocol for arbitrary raster graphics
- Supports: compression (zlib), source rectangles for partial display, flexible positioning within cells
- Images transmitted via APC sequences with Base64-encoded data
- Can use shared memory for large images (avoid re-encoding)
- **Most capable** of the three protocols
- Adopted by: Kitty, WezTerm, Ghostty, and others

#### iTerm2 Inline Images Protocol

- Simpler than Kitty's protocol
- Uses OSC 1337 sequences
- Base64-encoded image data with width/height parameters
- Widely supported due to iTerm2's macOS popularity

#### Implementation Challenges

- Inconsistent rendering across terminals (only Kitty and Ghostty produce identical results for some test cases; WezTerm and Konsole show artifacts)
- Interaction between image rendering and text operations (cursor positioning, scrolling) is the hardest part
- Memory management for cached images

Source: [Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/), [Are We Sixel Yet](https://www.arewesixelyet.com/)

---

### Font Fallback and Rendering

#### The Font Stack

A terminal emulator's text rendering stack has complexity comparable to a web browser:

1. **Text Segmentation**: Break text into runs by: Unicode script (Latin, Hangul, etc.), presentation (text vs emoji), and shared SGR attributes
2. **Font Selection**: For each run, select the appropriate font from the configured list. Emoji use a different font and fallback list than regular text.
3. **Text Shaping**: Pass each run to HarfBuzz with the selected font. HarfBuzz handles: ligatures, kerning, combining marks, complex script rules
4. **Rasterization**: FreeType (Linux/Windows), CoreText (macOS), or DirectWrite (Windows) rasterizes shaped glyphs
5. **Atlas Caching**: Rasterized glyphs stored in texture atlas

#### Font Fallback

When the primary font lacks a glyph:
- **WezTerm**: Asynchronously resolves fallback fonts without blocking rendering. Deduplication prevents repeated lookups. Coverage-based sorting prefers fonts covering more codepoints.
- **Warp (WASM)**: Implemented in-browser font fallback for their WebAssembly terminal, handling the constraint of limited system font access
- **General pattern**: Maintain a prioritized list of fallback fonts; on cache miss, search the list; cache the mapping from codepoint to font

Source: [Contour Text Stack](https://contour-terminal.org/internals/text-stack/), [Warp Font Fallback](https://www.warp.dev/blog/font-fallback-in-a-wasm-terminal)

#### Grid Alignment Constraint

Unlike a web browser, terminal text must align to a fixed-width grid. This means:
- Character placement is decided **before** text shaping
- Each grid cell contains exactly one grapheme cluster
- Shaped glyphs must be positioned relative to their cell's grid position
- Wide characters span exactly 2 cells; no fractional widths

This constraint is the source of most terminal text rendering bugs.

---

### Memory Management with Large Scrollback

#### The Memory Problem

For a 200-column terminal with 100,000 lines of scrollback:
- At **12 bytes/cell**: 200 * 100,000 * 12 = **228 MB per terminal**
- Multiply by number of open terminals/panes

#### Optimization Strategies

1. **Compressed scrollback rows**: Once a line moves to scrollback, compress it. The active screen uses rich per-cell structs; scrollback uses a compact format. Since scrollback is read-only, the format doesn't need random-write support.

2. **Shared style data**: Don't store full style information per cell. Use indexed styles with ref-counting (Ghostty's approach). Most cells share a small number of styles.

3. **Lazy grapheme storage**: Store single-codepoint characters inline (the 99% case). Only allocate separate storage for multi-codepoint graphemes.

4. **Disk offload**: VTE stores infinite scrollback on disk (compressed, encrypted). Good for unlimited history; bad for search latency.

5. **Line deduplication**: Empty lines (common in scrollback from `cat` output with trailing whitespace) can be stored as references to a single canonical empty line.

6. **Sparse storage**: Don't pre-allocate cells for the full terminal width if most lines are short. Store only the used portion plus a length.

---

## Part 3: Lessons from Open Source

### xterm.js: DOM to Canvas to WebGL

#### The Evolution

**Phase 1: DOM Renderer (Original)**
- Used HTML elements for each cell/row
- Flexible CSS styling but **extremely slow** for large viewports
- Every cell update triggered DOM manipulation and reflow
- The main reason VS Code terminal felt slow

**Phase 2: Canvas Renderer (Addon)**
- Used Canvas 2D API to draw text
- Significant performance improvement over DOM
- Became the default for a while
- Limitation: Canvas glyphs are expensive to draw and invalidate, restricting atlas size
- Performance degrades with very wide containers

**Phase 3: WebGL Renderer (Current Default)**
- VS Code transitioned to WebGL as default
- 3-5x faster than Canvas renderer
- Uses `Float32Array` for instance data, vertex/fragment shaders
- Multi-texture atlas (multiple 512x512 textures, merging up to 4096x4096)
- Every character redrawn every frame (cheaper via GPU parallelism than CPU-side dirty tracking)
- Average frame time: <1ms

**Current Architecture:**
- WebGL2 is the default renderer
- Canvas renderer is an addon fallback (when WebGL2 isn't supported)
- DOM renderer remains as the ultimate fallback (important for accessibility)
- The `IRenderer` abstraction allows all three to coexist

#### Key Lessons

1. **Start with the fastest renderer, not the easiest**. xterm.js spent years with DOM before canvas, then more years before WebGL. Each migration was expensive.
2. **Maintain a fallback chain**. Not all environments support WebGL2 (e.g., some Safari/iPad versions). Having Canvas as fallback and DOM as last resort ensures universal compatibility.
3. **Separate parser from renderer**. xterm.js's layered architecture made renderer swaps possible without touching the terminal emulation core.
4. **Accessibility requires DOM**. Even with WebGL rendering, xterm.js maintains a hidden DOM layer for screen readers. GPU rendering alone is inaccessible.

Source: [xterm.js Issue #3271](https://github.com/xtermjs/xterm.js/issues/3271), [xterm.js Renderer API Issue](https://github.com/xtermjs/xterm.js/issues/2005)

---

### Alacritty: What Made It Fast and Its Limitations

#### What Made It Fast

1. **Minimal rendering pipeline**: Two OpenGL draw calls per frame (background + glyphs). No compositor effects, no transparency overhead.
2. **High-throughput parser**: The `vte` crate uses table-driven parsing with procedural-macro-generated lookup tables. Minimal branching. Byte-at-a-time streaming.
3. **Glyph atlas with lazy rasterization**: Glyphs rasterized only on first use. Instance data uploaded once per frame.
4. **Small memory footprint**: ~8MB baseline. No unnecessary features means no unnecessary memory allocation.
5. **Rust ownership model**: No GC pauses. Deterministic memory management. Zero-cost abstractions.

#### Where It Benchmarked Well

Alacritty's renderer achieves ~500 FPS with a full screen of text. Only ~2ms per frame is rendering; the remaining 14.7ms (at 60Hz) is available for parsing. The `vtebench` tool was created by the Alacritty project specifically for throughput measurement.

#### Limitations and Trade-offs

1. **No tabs or splits**: Deliberate design choice. Users must use tmux or a tiling WM. This limits adoption among users who want an all-in-one terminal.
2. **No built-in multiplexing**: No session persistence if Alacritty crashes.
3. **No ligature support**: Historical limitation (being addressed). The simple cell-by-cell rendering model made ligatures difficult to add.
4. **OpenGL only**: No Metal on macOS, no Vulkan. OpenGL is deprecated on macOS, creating long-term maintenance risk.
5. **Minimal extensibility**: No plugin system, no scripting. Configuration is TOML only.

#### Architectural Lesson

Alacritty proves that **radical simplicity yields radical performance**. But simplicity can also limit growth. The `alacritty_terminal` crate's separation as a library was wise -- it allows others to build on the terminal emulation without inheriting the minimal UI philosophy.

Source: [Announcing Alacritty](https://jwilm.io/blog/announcing-alacritty/), [Alacritty Wikipedia](https://en.wikipedia.org/wiki/Alacritty)

---

### Kitty: Protocol Innovations

#### What Kitty Innovated

1. **Kitty Graphics Protocol**: The most capable inline image protocol. Supports compression, partial images, shared memory transmission, animation. Adopted by multiple other terminals.

2. **Kitty Keyboard Protocol**: Solved decades of keyboard input ambiguity. Now the de facto standard for modern terminal input, adopted by 7+ terminal emulators.

3. **Kittens Framework**: Python-based extensions that run inside the terminal. SSH kitten transmits shell integration scripts via Base64-encoded compressed tarballs over the TTY connection. Unicode input kitten provides a hex code entry UI.

4. **Protocol Extensions Philosophy**: Kitty's extensions are designed to be "as small and unobtrusive as possible, while filling in some gaps in the existing xterm protocol." Unknown sequences are safely ignored by other terminals.

5. **SIMD Parser**: 50-400% speedup over non-SIMD parsing, achieving 115+ MB/s for ASCII and 300+ MB/s for long escape codes.

6. **Character Width Protocol**: As of v0.40, programs can control how many cells a character renders in, solving the width problem at the protocol level.

#### Kitty's Approach vs Alacritty's

Where Alacritty says "use tmux for multiplexing," Kitty says "we'll build a better protocol." Kitty extends the terminal protocol itself rather than deferring to external tools. This creates a richer experience when both the terminal and the application support Kitty's extensions, but can create compatibility issues with older tools.

Source: [Kitty Protocol Extensions](https://sw.kovidgoyal.net/kitty/protocol-extensions/), [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)

---

### WezTerm: The Multiplexer Approach

#### What WezTerm Does Differently

1. **Built-in multiplexer**: Unlike Alacritty (no multiplexing) or Kitty (custom protocols), WezTerm is a **full terminal multiplexer** comparable to tmux but integrated into the terminal. Windows > Tabs > Panes in a binary tree.

2. **Client-server separation**: `wezterm-mux-server` runs headless. The GUI client attaches/detaches without losing sessions. Communication via PDU-based RPC (leb128 framing + bincode serialization).

3. **Lua scripting**: Full Lua runtime for configuration and automation. Events, key bindings, appearance, and behavior are all scriptable.

4. **Cross-platform PTY abstraction**: The `portable-pty` crate provides the most battle-tested cross-platform PTY interface in the Rust ecosystem.

5. **Lazy remote pane rendering**: `ClientPane` proxies remote panes, fetching lines only when `get_lines()` is called. Missing lines trigger `GetPaneRenderChanges` RPC. This makes remote terminal sessions feel local.

6. **Async font fallback**: When a glyph is missing, fallback fonts are resolved asynchronously without blocking rendering. Known-missing glyphs are deduplicated.

7. **19+ crates in the workspace**: Each subsystem (font, pty, term, mux, gui, codec, etc.) is a separate crate with clean interfaces. This is the most modular Rust terminal codebase.

#### Lessons

WezTerm demonstrates that **a maximalist feature set is achievable with the right modular architecture**. The key is clean crate boundaries and the multiplexer abstraction that decouples terminal emulation from GUI rendering.

Source: [WezTerm Multiplexing](https://wezterm.org/multiplexing.html), [WezTerm DeepWiki](https://deepwiki.com/wezterm/wezterm)

---

### Ghostty: Modern Architecture

#### Key Design Decisions

1. **libghostty as a reusable library**: The terminal core is extracted as a C/Zig library with zero dependencies. This allows other projects (emacs-libgterm, ghostling) to embed Ghostty's terminal emulation.

2. **Platform-native UI**: Swift/AppKit on macOS, GTK4/Zig on Linux. No cross-platform UI toolkit compromise. Each platform gets native look and feel.

3. **Three threads per surface**: Read (SIMD parser), Write (PTY input), Render (OpenGL/Metal). Maximum parallelism with clean separation.

4. **Page-based memory management**: The PageList data structure with offset-based addressing, memory pools, shared styles, and bitmap allocators for variable-sized data. Represents the state of the art in terminal memory management.

5. **SIMD-optimized parsing**: DFA state machine with CPU-specific SIMD (AVX2/SSE4.2/NEON). CSI fast-path. UTF-8 SIMD decoding. Tuned against real-world terminal session recordings (4GB asciinema dump).

6. **Best Unicode conformance**: Scored highest among all terminals in 2025 Unicode testing.

#### The Memory Leak Postmortem

Ghostty's memory leak saga is instructive:
- **Root cause**: Non-standard pages (oversized mmap allocations for emoji-heavy lines) were incorrectly recycled into the standard-size memory pool during scrollback pruning
- **Symptom**: Memory grew unboundedly, especially with Claude Code (which generates heavy Unicode output)
- **Fix**: Never reuse non-standard pages; destroy (munmap) and allocate fresh standard pages instead
- **Lesson**: Memory pool optimizations are powerful but introduce subtle bugs when pooled objects have variable sizes. Always validate the assumption that pooled objects are uniform.

Source: [Ghostty Memory Leak Fix](https://mitchellh.com/writing/ghostty-memory-leak-fix), [Ghostty DeepWiki](https://deepwiki.com/ghostty-org/ghostty)

---

### Hyper: Lessons from Electron

#### What Went Wrong and How It Was Fixed

**Problem 1: DOM rendering was catastrophically slow**
- The original Hyper used DOM-based terminal rendering
- Verbose command output would cause multi-second freezes
- **Fix**: Migrated from hterm to xterm.js with canvas renderer (Hyper 2), then WebGL (Hyper 3)

**Problem 2: IPC message flooding**
- The renderer process spent most of its time handling messages from the main process
- **Fix**: Batched IPC communication

**Problem 3: Sequential initialization**
- Hyper waited for the Chromium window to open before creating the PTY
- **Fix**: Parallelize window creation and PTY spawning

**Problem 4: Startup time**
- Electron's V8 engine spends significant time parsing and compiling JavaScript
- **Fix**: V8 snapshots -- pre-compiled heap snapshots that skip parse-and-compile for heavy dependencies

**Remaining issues**: Higher memory usage than native terminals (Electron overhead). Cross-platform consistency is good but performance floor is higher.

#### Key Lesson

**Electron/web technology can work for terminals, but every default must be overridden.** DOM rendering must be replaced with WebGL. IPC must be batched. Initialization must be parallelized. Startup must use snapshots. The web platform provides none of these optimizations by default.

For a Tauri-based terminal, these lessons are directly applicable: use canvas/WebGL from day one, minimize IPC between Rust backend and web frontend, and parallelize initialization.

Source: [Hyper Architecture](https://readoss.com/en/vercel/hyper/hypers-architecture-navigating-electron-terminal-emulator-codebase)

---

### Architectural Mistakes and Corrections

#### Common Mistakes Across Projects

1. **Starting with DOM rendering** (xterm.js, Hyper): Both spent years with slow DOM renderers before migrating to canvas/WebGL. The migration was expensive but necessary.

2. **Assuming wcwidth() is sufficient** (most terminals pre-2020): The entire ecosystem built on a broken assumption. Fixing grapheme cluster support required fundamental changes to cell storage and cursor logic.

3. **Single-threaded architecture** (early Alacritty, st): Blocking on PTY reads or GPU buffer swaps adds input latency. Multi-threaded designs (Ghostty) avoid this.

4. **Fixed-size glyph atlas** (xterm.js early WebGL): A single 1024x1024 texture runs out of space for Unicode-heavy content. Multi-texture atlases with dynamic sizing are necessary.

5. **Pooling variable-sized objects** (Ghostty memory leak): Memory pools must ensure all pooled objects are truly uniform. Variable-sized allocations need separate handling.

6. **Ignoring damage tracking** (early GPU terminals): "The GPU is fast enough to redraw everything" is true at 60Hz on small screens but fails on 4K displays with high refresh rates. Damage tracking is essential.

7. **Not separating terminal emulation from UI** (many terminals): Terminals that tightly couple parsing/emulation with rendering cannot be reused as libraries and are harder to test.

#### Corrections That Worked

- **xterm.js**: Clean `IRenderer` abstraction enabled swapping DOM/Canvas/WebGL without touching terminal logic
- **Alacritty**: Separating `alacritty_terminal` as a standalone crate
- **WezTerm**: 19-crate workspace with clean boundaries
- **Ghostty**: `libghostty` as a zero-dependency C library
- **Windows Terminal**: AtlasEngine rewrite replaced the original slow renderer with a 10x+ performance improvement

---

## Actionable Recommendations for a Canvas-Rendered Terminal

Based on this research, here are concrete recommendations for building a world-class canvas-rendered terminal:

### Architecture

1. **Separate terminal emulation from rendering completely.** The terminal state machine, buffer management, and VT parsing should be a standalone library (like `alacritty_terminal` or `libghostty`) with zero UI dependencies.

2. **Use three logical threads**: PTY reader (with SIMD-optimized parser), PTY writer, and renderer. In a Tauri/web context, this maps to: Rust backend thread for PTY + parsing, Web Worker for intermediate processing if needed, and main thread for canvas/WebGL rendering.

3. **Design the IPC boundary carefully.** The biggest performance risk in a Tauri architecture is the Rust-to-JS bridge. Batch terminal state updates. Consider SharedArrayBuffer for zero-copy data sharing between the Rust backend and the renderer.

### Rendering

4. **Start with WebGL/GPU rendering from day one.** Do not start with Canvas 2D or DOM. The migration cost (as xterm.js and Hyper learned) is enormous. WebGL should be the primary renderer with Canvas 2D as fallback.

5. **Implement a multi-texture glyph atlas.** Use multiple smaller textures (512x512) rather than one large one. Upload is faster, and you avoid the single-texture size limit. Pack glyphs by height into the most suitable row.

6. **Implement damage tracking immediately.** Track a dirty region per frame. In interactive use, only a few cells change. Skip full redraws. Use swap buffer damage extensions where available.

7. **Implement frame skipping for high-throughput scenarios.** When `cat huge_file.txt` floods the terminal, skip rendering intermediate states. Only render the latest state.

### Parsing

8. **Use the Paul Williams state machine** as the foundation. It is the industry standard. Consider the `vte` crate (Rust, battle-tested in Alacritty) or implement directly from the specification.

9. **Plan for SIMD optimization** of the parser hot path. Kitty and Ghostty demonstrate 2-5x real-world speedups. Focus SIMD on: ASCII scanning (skip state machine for printable ASCII runs), UTF-8 decoding, and CSI parameter parsing.

10. **Separate parsing from semantic processing.** The parser should emit tokens/actions; a separate handler should apply them to terminal state. This enables testing and profiling each independently.

### Unicode

11. **Implement UAX #29 grapheme cluster segmentation** from the start. Do not rely on wcwidth(). Optimize the fast path for ASCII (nearly zero overhead) while correctly handling complex graphemes.

12. **Store graphemes outside cells.** Single codepoints inline (the 99% case); multi-codepoint graphemes in a separate map keyed by cell offset (Ghostty's approach).

13. **Support the Kitty Keyboard Protocol.** It is the emerging standard for unambiguous input handling, adopted by 7+ major terminals.

### Memory

14. **Design for asymmetric access patterns.** Active screen: fast random read/write with rich per-cell data. Scrollback: append-only with compressed or compact storage. Use different data structures for each.

15. **Use shared style data with ref-counting.** Most cells share a small number of styles. An indexed style table dramatically reduces per-cell memory.

16. **Implement a memory pool for page allocation** but ensure all pooled objects are uniform in size. Variable-sized allocations (for complex content) must be handled separately to avoid Ghostty's leak pattern.

### Font Rendering

17. **Use HarfBuzz for text shaping** (ligatures, complex scripts, combining marks). Shape TextRuns (sequences of cells with shared properties), not individual cells.

18. **Implement async font fallback.** When a glyph is missing, resolve the fallback font asynchronously without blocking rendering. Cache the codepoint-to-font mapping. Deduplicate lookups for known-missing glyphs.

### Testing

19. **Integrate vttest and esctest into CI** from early development. Run esctest across VT100-VT525 levels in both ASCII and UTF-8 modes.

20. **Use real-world terminal session recordings** (asciinema) for performance tuning, not just synthetic benchmarks. Ghostty's approach of tuning against 4GB of real session data is the right model.

### Accessibility

21. **Maintain a hidden accessible text layer** synchronized with the canvas rendering. This is the only way to support screen readers with non-DOM rendering. xterm.js's approach of a parallel accessible DOM is the proven pattern.

---

## Key Sources

### Architecture and Design
- [Announcing Alacritty](https://jwilm.io/blog/announcing-alacritty/)
- [Alacritty DeepWiki](https://deepwiki.com/alacritty/alacritty)
- [WezTerm DeepWiki](https://deepwiki.com/wezterm/wezterm)
- [Ghostty DeepWiki](https://deepwiki.com/ghostty-org/ghostty)
- [About Ghostty](https://ghostty.org/docs/about)
- [xterm.js DeepWiki](https://deepwiki.com/xtermjs/xterm.js/1-overview)
- [Windows Terminal Atlas Engine](https://deepwiki.com/microsoft/terminal/3.2-atlas-engine)
- [Contour Internals](https://contour-terminal.org/internals/)
- [Foot Repository](https://codeberg.org/dnkl/foot)

### Rendering
- [How Zutty Works](https://tomscii.sig7.se/2020/11/How-Zutty-works)
- [Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [Warp: How Warp Works](https://www.warp.dev/blog/how-warp-works)
- [xterm.js WebGL Renderer PR](https://github.com/xtermjs/xterm.js/pull/1790)
- [Windows Terminal Text Rendering Revamp](https://visualstudiomagazine.com/articles/2022/02/07/windows-terminal-1-13.aspx)

### Parsing
- [VT100.net ANSI Parser](https://vt100.net/emu/dec_ansi_parser)
- [Alacritty vte crate](https://github.com/alacritty/vte)
- [Kitty SIMD Parser RFC](https://github.com/kovidgoyal/kitty/issues/7005)
- [Ghostty Devlog 006](https://mitchellh.com/writing/ghostty-devlog-006)
- [Ghostty VT Concepts](https://ghostty.org/docs/vt/concepts/sequences)

### Unicode
- [Grapheme Clusters in Terminals (Mitchell Hashimoto)](https://mitchellh.com/writing/grapheme-clusters-in-terminals)
- [State of Terminal Emulators 2025](https://www.jeffquast.com/post/state-of-terminal-emulation-2025/)
- [Contour Text Stack](https://contour-terminal.org/internals/text-stack/)
- [Terminal Unicode Core Spec](https://github.com/contour-terminal/terminal-unicode-core)
- [BiDi in Terminal Emulators](https://terminal-wg.pages.freedesktop.org/bidi/)
- [Rendering Complex Scripts in Terminal (OSC 66)](https://thottingal.in/blog/2026/03/22/complex-scripts-in-terminal/)

### Performance and Latency
- [Dan Luu: Terminal Latency](http://danluu.com/term-latency/)
- [Terminal Latency (beuke.org)](https://beuke.org/terminal-latency/)
- [LWN Terminal Emulators Part 2](https://lwn.net/Articles/751763/)
- [Kitty Performance](https://sw.kovidgoyal.net/kitty/performance/)

### Input
- [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
- [WezTerm Key Encoding](https://wezterm.org/config/key-encoding.html)

### Memory and Buffers
- [Ghostty Memory Leak Fix](https://mitchellh.com/writing/ghostty-memory-leak-fix)
- [WezTerm Scrollback](https://wezterm.org/scrollback.html)
- [Ghostty Page Memory and Cell Storage](https://deepwiki.com/ghostty-org/ghostty/3.6-kitty-graphics-protocol)

### PTY
- [portable-pty docs](https://docs.rs/portable-pty)
- [WezTerm PTY Management](https://deepwiki.com/wezterm/wezterm/4.5-pty-and-process-management)
- [ConPTY Performance](https://kichwacoders.com/2021/05/24/conpty-performance-in-eclipse-terminal/)

### Font Rendering
- [WezTerm Font Shaping](https://wezterm.org/config/font-shaping.html)
- [Warp Font Fallback in WASM](https://www.warp.dev/blog/font-fallback-in-a-wasm-terminal)
- [HarfBuzz FreeType Integration](https://harfbuzz.github.io/integration-freetype.html)

### Image Protocols
- [Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [Are We Sixel Yet](https://www.arewesixelyet.com/)
- [libsixel](https://saitoha.github.io/libsixel/)

### Testing
- [VTTEST](https://invisible-island.net/vttest/)
- [esctest2](https://github.com/ThomasDickey/esctest2)
- [Terminal Unicode Battle Royale](https://www.jeffquast.com/post/ucs-detect-test-results/)

### Accessibility
- [Accessibility of Command Line Interfaces (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3411764.3445544)

### Hyper/Electron Lessons
- [Hyper Architecture](https://readoss.com/en/vercel/hyper/hypers-architecture-navigating-electron-terminal-emulator-codebase)

### Protocol Extensions
- [Kitty Protocol Extensions](https://sw.kovidgoyal.net/kitty/protocol-extensions/)
- [Julia Evans: Escape Code Standards](https://jvns.ca/blog/2025/03/07/escape-code-standards/)
