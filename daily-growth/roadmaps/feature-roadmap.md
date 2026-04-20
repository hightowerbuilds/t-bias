# t-bias Feature Roadmap

> Everything Tobias can't do yet, organized into phases by priority.
> Phase order follows "what blocks daily use" → "what makes it pleasant"
> → "what makes it competitive."
>
> Written 2026-04-14.

---

## Phase 1 — Daily Driver

Make the terminal reliable enough to use as a primary shell every day.
These are the gaps that break real workflows.

### 1.1 Escape Sequence Hardening

Test against real TUI applications and fix what breaks.

- [ ] Run Vim/Neovim — fix any rendering, cursor, or mode issues
- [ ] Run htop — verify alternate screen, color rendering, mouse interaction
- [ ] Run tmux — test nested terminal handling, status bar, pane splits
- [ ] Run Claude Code — stress-test rapid output, SGR sequences, bracketed paste
- [ ] Run less/man — verify scrollback, alternate screen entry/exit
- [ ] Run nano — basic editing, status line
- [ ] Run git log/diff with color — verify 256-color and truecolor output
- [ ] Run ncurses test programs (if available) for systematic coverage
- [x] Audit and log all unhandled CSI/ESC/OSC sequences hit during testing
- [x] Implement the most-hit unhandled sequences from the audit

Note (2026-04-19): Full parser audit completed. Added: mode 1007 (alternate scroll — wheel sends cursor keys in alt screen for vim/less/htop), mode 1048 (standalone cursor save/restore for tmux), mode 1036 (meta sends ESC), window op 8 (set terminal size — vim), window op 16 (cell size in pixels). Alternate scroll wired into TerminalHost wheel handler. Unhandled CSI and DECSET sequences now log to console.debug in dev builds. SGR coverage verified complete (22/23/24/25/27/28/29 all present).

### 1.2 Grapheme Cluster Segmentation (UAX #29)

Emoji and complex scripts render incorrectly without this.

- [x] Research UAX #29 segmentation rules and existing JS libraries (e.g., `graphemer`, `Intl.Segmenter`)
- [x] Decide: use `Intl.Segmenter` (built-in, no dependency) vs. a library vs. custom implementation
- [x] Implement grapheme segmentation on the print path in `Screen.ts`
- [x] ASCII fast path — skip segmentation for single-byte characters (the 95%+ common case)
- [x] Update cursor advancement: grapheme cluster occupies 1 or 2 cells depending on width
- [x] Update `isWideChar()` to handle multi-codepoint sequences (emoji modifiers, ZWJ sequences)
- [x] Update selection: select by grapheme cluster, not by codepoint
- [x] Update `getSelectedText()` to extract full grapheme strings
- [x] Test with emoji: flags (🇺🇸), skin tones (👍🏽), ZWJ families (👨‍👩‍👧‍👦), compound emoji (1️⃣)
- [x] Test with combining characters: accented Latin, Devanagari, Arabic
- [ ] Verify grapheme materialization in scrollback still works correctly

Note (2026-04-19): Parser already used Intl.Segmenter with ASCII fast path. VirtualCanvas already stored multi-codepoint graphemes via GRAPHEME_SENTINEL. Fixed isWideChar() to detect VS16 (U+FE0F), combining enclosing keycap (U+20E3), and ZWJ sequences. Fixed getSelectedText() to skip wide-char placeholder cells. 7 new grapheme tests (skin tone, ZWJ family, flag, keycap, combining accent, CJK, mixed). 110 tests total.

### 1.3 Reflow on Resize

Wrapped lines should reflow when the terminal gets wider.

- [x] Track which lines are soft-wrapped (continuation of previous line) vs. hard-wrapped (ended with newline)
- [x] Add a `wrapped` flag per row in VirtualCanvas (1 bit per row)
- [x] On resize wider: merge soft-wrapped continuation rows back into the preceding line
- [x] On resize narrower: re-wrap long lines into multiple rows
- [x] Preserve cursor position relative to content (not absolute grid position) during reflow
- [ ] Handle reflow in scrollback — soft-wrapped rows in history should rejoin
- [x] Handle reflow with colored/attributed text — attributes must travel with their characters
- [x] Test with `cat` of a long-line file, resize, verify content integrity
- [ ] Test with shell prompt wrapping and unwrapping (manual)

Note (2026-04-19): Implemented `reflowResize` in Screen.ts — extracts logical lines (grouped by soft-wrap flags) with full cell attributes, resizes VC, then re-wraps to new column width. Handles wide chars (CJK/emoji) that don't fit at line end. Alt screen is never reflowed (matches xterm/kitty). 5 reflow tests: unwrap wider, re-wrap narrower, independent lines, colored text, CJK. 115 tests total. Scrollback reflow deferred.

### 1.4 Clipboard Integration (OSC 52)

Programs can request clipboard write via OSC 52. Currently received but ignored.

- [x] Decode base64 payload from OSC 52 sequences
- [x] Write decoded text to system clipboard via Tauri's clipboard API
- [x] Support read queries (OSC 52 with `?` payload) — respond with base64-encoded clipboard content
- [ ] Security: prompt or restrict clipboard access per-application (prevent silent clipboard hijacking)
- [ ] Test with programs that use OSC 52 (e.g., `pbcopy` alternatives, Neovim clipboard integration)

Note (2026-04-19): OSC 52 write was already working (base64 decode → navigator.clipboard). Added OSC 52 read query support — reads via Tauri clipboard plugin (avoids WebKit permission prompt), responds with base64-encoded content in the `\x1b]52;Pc;Pd\x07` format. Read uses the same Tauri clipboard plugin path as Cmd+V paste.

---

## Phase 2 — Comfort

Features that make the terminal pleasant to use, not just functional.

### 2.1 Configuration System

No settings are user-configurable today. Everything is hardcoded.

- [ ] Define a config file format (TOML, JSON, or YAML) and default location (`~/.config/tbias/config.toml` or similar)
- [ ] Configurable options:
  - [ ] Font family and size
  - [ ] Theme (background, foreground, cursor, selection, ANSI palette — all 16 colors)
  - [ ] Scrollback limit
  - [ ] Cursor style (block/underline/bar) and blink on/off
  - [ ] Shell command (override default shell)
  - [ ] Padding / margin around the terminal grid
  - [ ] Window opacity
  - [ ] Keybindings (at minimum: copy, paste, zoom, new tab, close tab)
- [ ] Hot-reload: watch the config file and apply changes without restart
- [ ] Ship sensible defaults that work out of the box
- [ ] Support popular theme formats or provide a few built-in themes (Dracula, Solarized, One Dark, Catppuccin)
- [ ] CLI flag to specify config path (`--config`)

### 2.2 Search in Scrollback

No way to find text in terminal history.

- [ ] Cmd+F opens a search bar (overlay at top or bottom of terminal)
- [ ] Incremental search: highlight matches as the user types
- [ ] Navigate matches with Enter (next) and Shift+Enter (previous)
- [ ] Highlight all matches in the visible viewport + scrollback
- [ ] Scroll to match when navigating to a match outside the viewport
- [ ] Regex support (toggle via button or prefix)
- [ ] Case sensitivity toggle
- [ ] ESC or Cmd+F again closes the search bar
- [ ] Search scope: active buffer + scrollback (not alt screen history)

### 2.3 URL Detection and Hyperlinks

No clickable URLs. OSC 8 hyperlinks not supported.

- [ ] **OSC 8 hyperlinks**: Parse `ESC ] 8 ; params ; uri ST` sequences, store URI per cell range
- [ ] Render hyperlinked text with underline (or configurable style)
- [ ] Cmd+Click on a hyperlink opens it in the default browser
- [ ] **Auto-detect URLs**: Regex scan visible text for `https?://`, `file://`, etc.
- [ ] Underline detected URLs on hover (mouse cursor changes to pointer)
- [ ] Cmd+Click on auto-detected URLs opens them
- [ ] Right-click on a URL offers "Copy Link" in context menu
- [ ] Handle URL wrapping across multiple lines

### 2.4 Shell Integration (OSC 133)

Enables prompt-aware features (jump between prompts, re-run commands).

- [ ] Parse OSC 133 sequences: prompt start (A), command start (B), command end (C), command finished (D)
- [ ] Mark prompt boundaries in scrollback
- [ ] Cmd+Up/Down to jump between prompts in scrollback
- [ ] Visual indicator for command exit status (success/failure) if the shell reports it
- [ ] Foundation for future "re-run last command" or "copy last output" features

### 2.5 Context Menu

No right-click menu.

- [ ] Right-click shows a context menu with:
  - [ ] Copy (if selection active)
  - [ ] Paste
  - [ ] Select All
  - [ ] Copy Link (if right-clicked on a URL)
  - [ ] Search (opens search bar with selected text)
  - [ ] Clear Scrollback
- [ ] Style the menu to match the terminal theme
- [ ] Keyboard-dismiss with ESC

---

## Phase 3 — Multi-Terminal Workflows

Single-terminal-per-window doesn't scale. This phase adds multiplexing.

### 3.1 Tabs

- [ ] Tab bar at the top of the window
- [ ] Cmd+T to open a new tab (spawns a new PTY)
- [ ] Cmd+W to close the current tab (with confirmation if process is running)
- [ ] Cmd+1-9 to switch tabs by index
- [ ] Cmd+Shift+[ and Cmd+Shift+] to cycle tabs
- [ ] Drag tabs to reorder
- [ ] Tab title from OSC 0/2 (or shell CWD if available via OSC 7)
- [ ] Visual indicator for tabs with recent activity (when not focused)
- [ ] Each tab has independent scrollback, selection, and terminal state
- [ ] Close confirmation when closing a window with multiple tabs

### 3.2 Pane Splits

- [ ] Cmd+D to split vertically (side-by-side)
- [ ] Cmd+Shift+D to split horizontally (stacked)
- [ ] Cmd+Option+Arrow to navigate between panes
- [ ] Drag pane dividers to resize
- [ ] Close a pane with Cmd+W (closes the pane's PTY, remaining panes reflow)
- [ ] Each pane is an independent terminal instance (own PTY, own scrollback)
- [ ] Visual border between panes with configurable color
- [ ] Zoom a pane to fill the tab (Cmd+Shift+Enter to toggle)
- [ ] Nested splits (split a split)

### 3.3 Session Management

- [ ] Remember window size, position, tab count, and split layout on quit
- [ ] Restore session on launch (configurable: always, never, ask)
- [ ] Named sessions (save/load specific layouts)
- [ ] Cmd+Shift+S to save current layout as a named session

---

## Phase 4 — Rich Content

Support for content beyond text.

### 4.1 Image Protocol Support

- [ ] **Kitty graphics protocol**: inline images, placement, animation
  - [ ] Parse APC/OSC sequences for image data (base64 or shared memory)
  - [ ] Render images into the canvas at the specified cell region
  - [ ] Handle image scrolling (images scroll with their anchor row)
  - [ ] Handle image deletion commands
- [ ] **Sixel graphics**: legacy image format used by some tools
  - [ ] Parse DCS Sixel sequences
  - [ ] Rasterize Sixel data to pixels
  - [ ] Render at the cursor position
- [ ] **iTerm2 inline images**: OSC 1337 with base64 image data
  - [ ] Parse the sequence and decode the image
  - [ ] Render at cursor position with specified width/height
- [ ] Prioritize Kitty protocol (most actively developed, widest modern adoption)

### 4.2 Font Fallback

Missing glyphs render as blank or tofu.

- [ ] Detect missing glyphs (measure width = 0, or check font coverage via `document.fonts`)
- [ ] Define a fallback font chain (e.g., Menlo → Symbols Nerd Font → Apple Color Emoji → Last Resort)
- [ ] When a glyph misses in the primary font, rasterize from the first fallback that has it
- [ ] Cache the font used per glyph in the atlas (key already includes the char)
- [ ] Allow configuring fallback fonts in the config file
- [ ] Handle color emoji fonts (Apple Color Emoji, Noto Color Emoji) — these need RGBA rendering, not grayscale

### 4.3 Ligature Support

Ligature fonts (Fira Code, JetBrains Mono) don't render ligatures.

- [ ] Detect when a ligature font is configured
- [ ] Identify ligature sequences (e.g., `=>`, `->`, `!=`, `===`) via font shaping or a lookup table
- [ ] Render ligature sequences as a single glyph spanning multiple cells
- [ ] Handle cursor positioning within a ligature (cursor sits between logical characters, not visual glyphs)
- [ ] Handle partial overwrites of a ligature (writing into the middle breaks it back to individual chars)
- [ ] Make ligatures configurable (on/off, and which ligatures to enable)

---

## Phase 5 — Platform and Accessibility

Make Tobias work everywhere and for everyone.

### 5.1 Cross-Platform Verification

Only tested on macOS.

- [ ] **Windows**: Build and test on Windows 10/11
  - [ ] Verify PTY spawning (ConPTY via portable-pty)
  - [ ] Test with PowerShell and CMD
  - [ ] Fix any keybinding conflicts (Ctrl vs. Cmd)
  - [ ] Verify font rendering and DPR handling on Windows
  - [ ] Test with Windows Terminal-style features (if applicable)
- [ ] **Linux**: Build and test on major distros (Ubuntu, Fedora, Arch)
  - [ ] Verify PTY spawning
  - [ ] Test with bash, zsh, fish
  - [ ] Handle Wayland vs. X11 differences (if any affect Tauri)
  - [ ] Verify font rendering with fontconfig
  - [ ] Test keyboard layouts (international keyboards)
- [ ] CI pipeline: automated builds for all three platforms
- [ ] Platform-specific keybindings (Cmd on macOS, Ctrl on Windows/Linux)

### 5.2 IME Support

Input method editors for CJK languages don't work.

- [ ] Wire up `compositionstart`, `compositionupdate`, `compositionend` events on the input target
- [ ] Render the composition string at the cursor position (inline pre-edit display)
- [ ] Handle composition candidates window positioning
- [ ] Commit the final composed text to the PTY on `compositionend`
- [ ] Test with macOS Japanese IME, Chinese Pinyin, Korean IME
- [ ] Test with Windows IME
- [ ] Test with IBus/Fcitx on Linux

### 5.3 Accessibility

No screen reader support.

- [ ] Research terminal accessibility patterns (how iTerm2 and Windows Terminal handle it)
- [ ] Add ARIA roles and live regions for screen reader announcements
- [ ] Announce new terminal output (debounced, summarized)
- [ ] Make the cursor position queryable by assistive technology
- [ ] High-contrast theme option
- [ ] Configurable cursor blink (or disable blink entirely)
- [ ] Ensure all keybindings are accessible (no mouse-only interactions for critical features)

### 5.4 Bell and Notifications

No bell handling.

- [ ] BEL character (0x07): visual bell (flash the terminal briefly) or system sound
- [ ] Configurable: visual bell, audio bell, or none
- [ ] OSC 9 (desktop notification) or OSC 777 (notification with body)
- [ ] Bounce dock icon / taskbar flash on bell when terminal is not focused
- [ ] Notification when a long-running command finishes (via shell integration or timer heuristic)

---

## Phase 6 — Performance and Architecture

Optimizations that require architectural changes. Do these when the feature
set is stable and benchmarking reveals actual bottlenecks.

### 6.1 Web Worker Rendering

Free the main thread entirely from rendering work.

- [ ] Move `CanvasRenderer` to a Web Worker
- [ ] Use `OffscreenCanvas` (transferred to the worker) for the text layer
- [ ] Main thread handles only: input events, cursor/selection overlay, IPC
- [ ] Communication: main thread sends `RenderState` snapshots to the worker via `postMessage` or `SharedArrayBuffer`
- [ ] Measure input latency before/after — worker rendering should not add latency to keystroke echo

### 6.2 WebGL Renderer

Canvas 2D with a glyph atlas is fast, but WebGL can be faster for large grids.

- [ ] Implement `IRenderer` with a WebGL backend
- [ ] Glyph atlas as a GPU texture (same atlas pages, uploaded as textures)
- [ ] Instanced quad rendering: one draw call per atlas page, not per glyph
- [ ] Cell data uploaded as a texture or buffer (interleaved ArrayBuffer maps directly to vertex attributes)
- [ ] Background colors as a separate pass (or combined with glyph pass via shader)
- [ ] Benchmark against Canvas 2D renderer at various grid sizes (80×24, 200×50, 300×80)
- [ ] Automatic fallback to Canvas 2D if WebGL is unavailable
- [ ] Make renderer selectable in config (auto, canvas2d, webgl)

### 6.3 Benchmarking Suite

No systematic way to measure performance.

- [ ] Throughput benchmark: measure bytes/second the parser can process (`cat /dev/urandom | head -c 10M`)
- [ ] Render benchmark: measure frame time for full redraw vs. partial redraw at various grid sizes
- [ ] Input latency benchmark: measure keystroke-to-pixel time
- [ ] Scrollback stress test: fill 5,000 rows, scroll through them, measure frame times
- [ ] Compare against xterm.js, Alacritty, WezTerm, Kitty on the same benchmarks
- [ ] Regression tracking: run benchmarks in CI and alert on regressions
- [ ] Integrate with the debug overlay (Cmd+Shift+D) for live monitoring

---

## Phase Summary

```
Phase 1 — Daily Driver
  1.1  Escape sequence hardening (test with real TUI apps)
  1.2  Grapheme cluster segmentation (UAX #29)
  1.3  Reflow on resize
  1.4  Clipboard integration (OSC 52)

Phase 2 — Comfort
  2.1  Configuration system (theme, font, keybindings)
  2.2  Search in scrollback
  2.3  URL detection and hyperlinks (OSC 8)
  2.4  Shell integration (OSC 133)
  2.5  Context menu

Phase 3 — Multi-Terminal Workflows
  3.1  Tabs
  3.2  Pane splits
  3.3  Session management

Phase 4 — Rich Content
  4.1  Image protocol support (Kitty, Sixel, iTerm2)
  4.2  Font fallback
  4.3  Ligature support

Phase 5 — Platform and Accessibility
  5.1  Cross-platform verification (Windows, Linux)
  5.2  IME support
  5.3  Accessibility (screen readers)
  5.4  Bell and notifications

Phase 6 — Performance and Architecture
  6.1  Web Worker rendering
  6.2  WebGL renderer
  6.3  Benchmarking suite
```

Phases are ordered by priority. Within each phase, items can be done in any order
unless noted. Phase 1 should be completed before shipping to anyone. Phase 2 is
what makes people want to keep using it. Phases 3-6 are what makes it competitive.
