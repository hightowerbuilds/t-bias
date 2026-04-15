# t-bias

A terminal emulator built from scratch. Canvas-rendered, zero third-party terminal dependencies, packaged as a native desktop app via Tauri.

## What It Is

t-bias (Tobias) is a terminal emulator that renders entirely to HTML Canvas — no DOM nodes for text, no xterm.js, no vterm.js. The VT/ANSI escape sequence parser, terminal state machine, and rendering engine are all custom TypeScript. The backend is Rust, managing a real PTY via `portable-pty` and communicating with the frontend through Tauri's IPC.

The goal is a lightweight, fully-owned terminal that can run shells, CLI tools, and TUI applications with a clean, understood implementation at every layer.

## What It Can Do

- **Run a real shell** — spawns your default shell (or a configured one) with `TERM=xterm-256color` and `COLORTERM=truecolor`
- **Render text via Canvas 2D** with a glyph atlas (each unique glyph rasterized once, then blitted via `drawImage`)
- **256-color and 24-bit truecolor** — full SGR support including bold, italic, faint, inverse, hidden, strikethrough, overline, and five underline styles (single, double, curly, dotted, dashed) with independent underline color
- **Alternate screen buffer** — modes 47, 1047, 1049 with cursor save/restore
- **Mouse tracking** — modes 1000 (click), 1002 (drag), 1003 (any-event) with SGR extended encoding (1006)
- **Bracketed paste, focus events** — modes 2004 and 1004
- **DEC graphics charset** — box-drawing characters via G0/G1 designation (ESC ( 0) and SO/SI switching
- **Scrollback** — configurable limit (default 5,000 lines), navigate with Shift+PageUp/Down or mouse wheel
- **Selection and copy** — click-drag to select, Cmd+C to copy
- **Font zoom** — Cmd+/- to resize, Cmd+0 to reset
- **Tab stops** — HTS, TBC, CHT, CBT
- **Cursor shapes** — block, underline, bar (DECSCUSR)
- **Window title** — OSC 0/1/2 with push/pop (CSI 22/23 t)
- **Device responses** — DA1, DA2, DSR (cursor position report)
- **Resize handling** — terminal grid reflows on window resize, PTY is notified
- **Split panes** — recursive pane tree with draggable dividers (horizontal and vertical splits)
- **Session persistence** — auto-session and named sessions; pane layout is saved and restored across restarts
- **Configuration file** — TOML config at `~/.config/tbias/config.toml` for shell, scrollback, font, cursor, theme, and session restore behavior

## What It Cannot Do (Yet)

Being honest about the gaps:

- **No grapheme cluster segmentation (UAX #29)** — emoji sequences and complex combining characters may not measure or render correctly. CJK wide characters are detected via Unicode East Asian Width ranges, but multi-codepoint emoji (e.g., family emoji, flag sequences) are not properly segmented.
- **No hyperlink support** — OSC 8 is parsed and tracked in cell data but not rendered as clickable links. (The HTML-in-Canvas layer has the wiring for this — see below.)
- **No image protocol** — no Sixel, Kitty image protocol, or iTerm2 inline images.
- **No ligature support** — monospace ligature fonts (Fira Code, JetBrains Mono) won't render ligatures.
- **No IME support** — input method editors for CJK languages are not wired up.
- **No search** — no find-in-scrollback.
- **No reflow on resize** — wrapped lines don't reflow when the terminal gets wider. Content is preserved but layout isn't adjusted.
- **Limited escape sequence coverage** — the parser handles CSI, OSC, DCS, APC, and PM sequences, but not every sequence is implemented in the state machine. Niche sequences from less common TUI frameworks may be silently ignored.
- **Single platform tested** — built and tested on macOS. Tauri supports Windows and Linux, but Tobias hasn't been verified on those platforms.
- **No clipboard write** — OSC 52 clipboard write is received but not acted on.

## Experimental: HTML-in-Canvas

> **Status: Experimental — requires Chrome Canary with a feature flag enabled.**

t-bias ships with support for the [WICG HTML-in-Canvas proposal](https://github.com/WICG/canvas-place-element), an emerging browser capability that lets real DOM elements live inside an HTML Canvas and participate in layout, painting, and the accessibility tree alongside the canvas's 2D rendering.

This is not a mainstream feature. As of writing it exists only in Chrome Canary behind `chrome://flags/#canvas-draw-element`. It is **not enabled by default** and falls back cleanly if unsupported.

### What It Enables

The core canvas renderer draws text into raw pixels. That is fast and gives us complete control over appearance, but it cuts the terminal off from the rest of the browser platform — screen readers can't read it, hyperlinks aren't real links, and shell integration regions are invisible to anything outside the canvas.

HTML-in-Canvas bridges that gap:

- **Accessibility rows** — invisible `<div>` elements, one per viewport row, carry the terminal's text content into the accessibility tree. Screen readers can traverse the terminal output without any special AT mode.
- **Off-canvas live region** — a hidden ARIA live region announces new terminal output to assistive technology as it arrives, so screen reader users hear shell output in real time.
- **OSC 8 hyperlinks** — terminal hyperlinks (URLs printed via `ESC ]8;;url ST text ESC ]8;; ST`) are wired to real `<a>` elements inside the canvas. A link pool keeps a fixed number of `<a>` nodes alive and recycles them as new links scroll into view.
- **OSC 133 shell integration** — prompt, command, and output sections are marked up as `<section>` elements with semantic roles (prompt, command, output). This makes prompt boundaries machine-readable and navigable.
- **Sync via `onpaint`** — instead of `requestAnimationFrame`, the HTML layer uses the canvas's `onpaint` event, which fires after DOM mutations are flushed. This keeps the DOM layer in sync with the canvas layer without extra timing hacks.

### How to Enable It

1. Install [Chrome Canary](https://www.google.com/chrome/canary/)
2. Navigate to `chrome://flags/#canvas-draw-element`
3. Set the flag to **Enabled**
4. Relaunch Canary
5. Run t-bias inside the Tauri webview (which uses the system WebKit on macOS — feature availability depends on your WebKit version) or serve the frontend in Canary for development

### Why It Matters

Most terminal emulators that render to canvas treat accessibility as an afterthought — a parallel DOM shadow that is expensive to maintain and easy to get wrong. The HTML-in-Canvas approach lets the same DOM that drives layout also drive accessibility. The `<a>` elements for hyperlinks are real links; they behave correctly in the accessibility tree, respond to keyboard navigation, and don't require any special emulation.

Shell integration (`OSC 133`) similarly benefits: prompt boundaries can be used by tools beyond just the terminal's own UI. A future version could expose these sections to automation or allow jumping between prompts the way a screen reader jumps between headings.

### Detection

At startup, `htmlInCanvas.ts` probes for four capabilities:

```typescript
canvas.layoutSubtree
canvas.requestPaint()
canvas.onpaint
CanvasRenderingContext2D.prototype.drawElementImage()
```

If any are missing, the HTML-in-Canvas layer is skipped entirely and the terminal runs in standard canvas-only mode. No errors, no degraded behavior — the feature is purely additive.

## Architecture

```
Keyboard/Mouse ──> TerminalHost ──> Tauri IPC ──> Rust PTY (portable-pty)
                                                        |
PTY output ────────────────────────> Tauri IPC ──> TerminalHost
                                                        |
                                                  TerminalCore
                                                   |        |
                                                Parser    Screen
                                                   |        |
                                              (VT state  (cell data,
                                               machine)   cursor,
                                                          modes)
                                                        |
                                                  VirtualCanvas
                                                  (typed arrays,
                                                   row indirection,
                                                   ring buffer
                                                   scrollback)
                                                        |
                                          ┌─────────────┴─────────────┐
                                     CanvasRenderer             HTML-in-Canvas
                                     (glyph atlas,              (a11y rows,
                                      dirty-row partial          hyperlinks,
                                      redraws, sub-row           shell integration,
                                      column tracking)           live region)
```

**Frontend** (TypeScript + SolidJS):
- `Parser.ts` — VT500-model state machine (CSI, OSC, DCS, APC, PM, colon sub-parameters)
- `Screen.ts` — terminal state: cursor, modes, SGR, scroll regions, charsets, erase/insert/delete
- `VirtualCanvas.ts` — Structure-of-Arrays cell buffer with row indirection for zero-copy scroll, oversized buffer allocation for resize-free operation, per-row grapheme storage, and a pre-allocated ring buffer for scrollback
- `Renderer.ts` — Canvas 2D renderer with three-pass drawing (backgrounds, glyphs, decorations), glyph atlas caching, and sub-row dirty column tracking
- `TerminalHost.ts` — DOM orchestrator: 3-layer canvas stack, input handling, cursor blink, write coalescing, debug overlay
- `htmlInCanvas.ts` — HTML-in-Canvas layer: feature detection, a11y rows, link pool, shell integration sections
- `input.ts` — keyboard event to VT escape sequence mapping
- `Panes.tsx` / `pane-tree.ts` — recursive split-pane tree with draggable dividers

**Backend** (Rust):
- `pty.rs` — PTY management via `portable-pty`: spawn, read (64KB buffer), write, resize, close
- `config.rs` — TOML config loading from `~/.config/tbias/config.toml`
- `session.rs` — auto-session and named session persistence

## Configuration

t-bias reads `~/.config/tbias/config.toml` on startup. If the file doesn't exist, defaults are used. See `config.example.toml` in the repo for all options.

```toml
shell = "/bin/zsh"              # leave empty to use $SHELL

scrollback_limit = 5000
padding = 0

[font]
family = "Menlo, Monaco, 'Courier New', monospace"
size = 14

[cursor]
style = "block"                 # "block", "underline", or "bar"
blink = true

[session]
restore = "ask"                 # "always", "never", or "ask"

[theme]
background = "#1e1e1e"
foreground = "#d4d4d4"
cursor     = "#d4d4d4"
selection_bg = "#264f78"
ansi = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff"
]
```

## Performance Design

- **Glyph atlas** — each unique glyph (char + style + color) rasterized once into an OffscreenCanvas, then blitted via `drawImage`. Up to 4 atlas pages (1024×1024 each) with LRU eviction.
- **Dirty-row tracking** — only changed rows are redrawn. Sub-row column ranges limit rendering to the exact changed region within a row.
- **Row indirection** — scroll operations rotate indices in a small `Uint16Array` instead of copying cell data. Zero bytes moved during scroll.
- **Write coalescing** — rapid PTY output events are buffered and flushed once per `requestAnimationFrame`, reducing parser invocations.
- **Oversized buffers** — pages pre-allocated at 320×100 minimum. Resize within those bounds requires no allocation — just update logical dimensions.
- **Ring buffer scrollback** — single pre-allocated buffer, O(1) push and eviction, no per-row allocation.
- **No-op detection** — `setCell()` compares all 5 attributes before writing, skipping unchanged cells entirely.
- **Structure-of-Arrays layout** — cell data stored across 5 typed arrays (`chars`, `fg`, `bg`, `attrs`, `ulColor`), cache-friendly and SharedArrayBuffer-ready for future off-main-thread parsing.

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri v2 |
| PTY management | Rust + portable-pty |
| Package manager | Bun |
| Bundler | Vite 8 + esbuild |
| Frontend framework | SolidJS |
| Language | TypeScript (frontend), Rust (backend) |
| Text measurement | @chenglou/pretext |
| Terminal emulation | Custom (no third-party terminal deps) |
| Experimental layer | WICG HTML-in-Canvas |

## Development

```bash
# Install dependencies
bun install

# Dev mode (Vite dev server on port 1420)
bun run dev

# Run tests
bun run test
bun run test:watch

# Build for production
bun run build
```

To run the full Tauri app:

```bash
cd src-tauri
cargo tauri dev

# Production build
cargo tauri build
```

## Debug Tools

- **Cmd+Shift+D** — toggle debug overlay showing draw time, dirty rows, atlas stats, input latency, and throughput
- **Cmd+Shift+S** — dump screen state to browser console (grid dimensions, cursor position, typed array content)

## Tests

48 tests via Vitest covering cursor movement, text output, line wrapping, erase operations, SGR (truecolor, palette, colon sub-params), scroll regions, tab stops, DEC graphics charset, alternate screen, terminal modes, device responses, soft reset, insert/delete operations, and typed-array consistency across TUI-like scenarios.

```bash
bun run test
```

## Status

t-bias is a working terminal emulator — functional enough to run a shell, navigate directories, use git, and interact with command-line tools. It handles the core VT/ANSI sequences that most CLI programs rely on.

It has not been stress-tested against the full range of TUI applications (Vim, htop, tmux, Claude Code). Some of these will work, some will expose escape sequence gaps. That testing and hardening is the next phase of development.

The HTML-in-Canvas layer is an early proof-of-concept, tracking the WICG proposal as it evolves. The wiring is in place; the feature will mature as the spec and browser implementations do.
