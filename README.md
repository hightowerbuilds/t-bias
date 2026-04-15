# Tobias

A terminal emulator built from scratch. Canvas-rendered, zero third-party terminal dependencies, packaged as a native desktop app via Tauri.

## What It Is

Tobias is a terminal emulator that renders entirely to HTML Canvas — no DOM nodes for text, no xterm.js, no vterm.js. The VT/ANSI escape sequence parser, terminal state machine, and rendering engine are all custom TypeScript. The backend is Rust, managing a real PTY via `portable-pty` and communicating with the frontend through Tauri's IPC.

The goal is a lightweight, fully-owned terminal that can run shells, CLI tools, and TUI applications.

## What It Can Do

- **Run a real shell** — spawns your default shell with `TERM=xterm-256color` and `COLORTERM=truecolor`
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

## What It Cannot Do (Yet)

Being honest about the gaps:

- **No grapheme cluster segmentation (UAX #29)** — emoji sequences and complex combining characters may not measure or render correctly. CJK wide characters are detected via Unicode East Asian Width ranges, but multi-codepoint emoji (e.g., family emoji, flag sequences) are not properly segmented.
- **No hyperlink support** — OSC 8 is not implemented. Clickable URLs are not rendered.
- **No image protocol** — no Sixel, Kitty image protocol, or iTerm2 inline images.
- **No ligature support** — monospace ligature fonts (Fira Code, JetBrains Mono) won't render ligatures.
- **No IME support** — input method editors for CJK languages are not wired up.
- **No search** — no find-in-scrollback.
- **No tabs or splits** — single terminal instance per window.
- **No configuration file** — theme, font, and scrollback limit are hardcoded. No settings UI.
- **No reflow on resize** — wrapped lines don't reflow when the terminal gets wider. Content is preserved but layout isn't adjusted.
- **Limited escape sequence coverage** — the parser handles CSI, OSC, DCS, APC, and PM sequences, but not every sequence is implemented in the state machine. Niche sequences from less common TUI frameworks may be silently ignored.
- **Single platform tested** — built and tested on macOS. Tauri supports Windows and Linux, but Tobias hasn't been verified on those platforms.
- **No clipboard integration beyond Cmd+C** — OSC 52 clipboard write is received but not acted on.

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
                                                  CanvasRenderer
                                                  (glyph atlas,
                                                   dirty-row partial
                                                   redraws, sub-row
                                                   column tracking)
```

**Frontend** (TypeScript + SolidJS):
- `Parser.ts` — VT500-model state machine (CSI, OSC, DCS, APC, PM, colon sub-parameters)
- `Screen.ts` — terminal state: cursor, modes, SGR, scroll regions, charsets, erase/insert/delete
- `VirtualCanvas.ts` — Structure-of-Arrays cell buffer with row indirection for zero-copy scroll, oversized buffer allocation for resize-free operation, per-row grapheme storage, and a pre-allocated ring buffer for scrollback
- `Renderer.ts` — Canvas 2D renderer with three-pass drawing (backgrounds, glyphs, decorations), glyph atlas caching, and sub-row dirty column tracking
- `TerminalHost.ts` — DOM orchestrator: 3-layer canvas stack, input handling, cursor blink, write coalescing, debug overlay
- `input.ts` — keyboard event to VT escape sequence mapping

**Backend** (Rust):
- `pty.rs` — PTY management via `portable-pty`: spawn, read (64KB buffer), write, resize

## Performance Design

- **Glyph atlas** — each unique glyph (char + style + color) rasterized once into an OffscreenCanvas, then blitted via `drawImage`. Up to 4 atlas pages (1024x1024 each) with LRU eviction.
- **Dirty-row tracking** — only changed rows are redrawn. Sub-row column ranges limit rendering to the exact changed region within a row.
- **Row indirection** — scroll operations rotate indices in a small `Uint16Array` instead of copying cell data. Zero bytes moved during scroll.
- **Write coalescing** — rapid PTY output events are buffered and flushed once per `requestAnimationFrame`, reducing parser invocations.
- **Oversized buffers** — pages pre-allocated at 320x100 minimum. Resize within those bounds requires no allocation — just update logical dimensions.
- **Ring buffer scrollback** — single pre-allocated buffer, O(1) push and eviction, no per-row allocation.
- **No-op detection** — `setCell()` compares all 5 attributes before writing, skipping unchanged cells entirely.

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

## Development

```bash
# Install dependencies
bun install

# Dev mode (Vite dev server on port 1420)
bun run dev

# Run tests
bun run test

# Build for production
bun run build
```

To run the full Tauri app:

```bash
cd src-tauri
cargo tauri dev
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

Tobias is a working terminal emulator — functional enough to run a shell, navigate directories, use git, and interact with command-line tools. It handles the core VT/ANSI sequences that most CLI programs rely on.

It has not been stress-tested against the full range of TUI applications (Vim, htop, tmux, Claude Code). Some of these will work, some will expose escape sequence gaps. That testing and hardening is the next phase of development.
