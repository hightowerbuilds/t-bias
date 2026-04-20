# t-bias Feature Roadmap

> Everything Tobias can't do yet, organized into phases by priority.
> Phase order follows "what blocks daily use" → "what makes it pleasant"
> → "what makes it competitive."
>
> Written 2026-04-14. Audited 2026-04-19.

---

## Phase 1 — Daily Driver — COMPLETE

Make the terminal reliable enough to use as a primary shell every day.

### 1.1 Escape Sequence Hardening

- [x] Audit and log all unhandled CSI/ESC/OSC sequences hit during testing
- [x] Implement the most-hit unhandled sequences from the audit
- [ ] Run Vim/Neovim — fix any rendering, cursor, or mode issues (manual)
- [ ] Run htop — verify alternate screen, color rendering, mouse interaction (manual)
- [ ] Run tmux — test nested terminal handling, status bar, pane splits (manual)
- [ ] Run Claude Code — stress-test rapid output, SGR sequences, bracketed paste (manual)
- [ ] Run less/man — verify scrollback, alternate screen entry/exit (manual)
- [ ] Run nano — basic editing, status line (manual)
- [ ] Run git log/diff with color — verify 256-color and truecolor output (manual)

Note (2026-04-19): Added modes 1007 (alternate scroll), 1048 (cursor save/restore), 1036 (meta sends ESC), window ops 8/16. Unhandled sequences log to console.debug. SGR coverage verified complete.

### 1.2 Grapheme Cluster Segmentation (UAX #29) — COMPLETE

- [x] Intl.Segmenter with ASCII fast path
- [x] Multi-codepoint graphemes stored via GRAPHEME_SENTINEL in VirtualCanvas
- [x] isWideChar handles VS16, ZWJ, keycap sequences
- [x] getSelectedText skips wide-char placeholder cells
- [x] Tests: skin tone, ZWJ family, flag, keycap, combining accent, CJK, mixed

### 1.3 Reflow on Resize — COMPLETE

- [x] Soft-wrap tracking per row
- [x] Merge soft-wrapped rows when widening
- [x] Re-wrap long lines when narrowing
- [x] Cursor position preserved relative to content
- [x] Wide char (CJK/emoji) boundary handling
- [x] Tests: unwrap wider, re-wrap narrower, independent lines, colored text, CJK

### 1.4 Clipboard Integration (OSC 52) — COMPLETE

- [x] Base64 decode + clipboard write
- [x] Read query support (responds with base64 clipboard content)

---

## Phase 2 — Comfort — COMPLETE

Features that make the terminal pleasant to use, not just functional.

### 2.1 Configuration System

- [x] TOML config at `~/.config/tbias/config.toml` with serde defaults
- [x] Font family/size, theme colors (16 ANSI), scrollback, cursor, shell, padding
- [x] Built-in theme presets: Dracula, Solarized Dark, One Dark, Catppuccin Mocha
- [x] Sensible defaults out of the box

### 2.2 Search in Scrollback — COMPLETE

- [x] Cmd+F, incremental, prev/next, highlight, scroll-to-match, regex, case toggle, ESC close

### 2.3 URL Detection and Hyperlinks — COMPLETE

- [x] OSC 8 hyperlinks stored per cell, auto-detect via regex, Cmd+Click, hover underline, context menu

### 2.4 Shell Integration (OSC 133) — COMPLETE

- [x] Prompt marks A/B/C/D, Cmd+Up/Down navigation, exit status indicators

### 2.5 Context Menu — COMPLETE

- [x] Copy, Paste, Select All, Search, Clear Scrollback, Open/Copy Link, ESC dismiss

---

## Phase 3 — Multi-Terminal Workflows — COMPLETE

### 3.1 Tabs — COMPLETE

- [x] Tab bar at the top of the window
- [x] Cmd+T to open a new tab
- [x] Cmd+W to close current tab (with confirmation if process running)
- [x] Cmd+1-9 to switch tabs by index
- [x] Cmd+Shift+[ and Cmd+Shift+] to cycle tabs
- [x] Tab title from OSC 0/2 and foreground process detection
- [x] Visual indicator for tabs with recent activity
- [x] Each tab has independent scrollback, selection, and terminal state
- [x] Close confirmation when closing with running processes

### 3.2 Pane Splits — COMPLETE

- [x] Cmd+D horizontal split, Cmd+Shift+D vertical split
- [x] Cmd+Option+Arrow to navigate between panes
- [x] Drag pane dividers to resize
- [x] Cmd+W closes the pane, remaining panes reflow
- [x] Each pane is an independent terminal instance
- [x] Zoom pane to fill tab (Cmd+Shift+Enter)
- [x] Nested splits

### 3.3 Session Management — COMPLETE

- [x] Full workspace layout auto-saved on quit (session.json)
- [x] Restore on launch (configurable: always, never, ask)
- [x] Named sessions (save/load via Rust backend)
- [x] Shell records linked via shellId for session continuity

---

## Phase 4 — Rich Content — FUTURE

### 4.1 Image Protocol Support
- [ ] Kitty graphics protocol
- [ ] Sixel graphics
- [ ] iTerm2 inline images (OSC 1337)

### 4.2 Font Fallback
- [ ] Detect missing glyphs, fallback font chain, color emoji

### 4.3 Ligature Support
- [ ] Detect ligature font, render multi-cell ligatures, configurable

---

## Phase 5 — Platform and Accessibility — PARTIAL

### 5.1 Cross-Platform Verification
- [ ] Windows build and test
- [ ] Linux build and test
- [ ] CI pipeline for all platforms

### 5.2 IME Support — MOSTLY COMPLETE
- [x] compositionstart/compositionupdate/compositionend handlers
- [x] Pre-edit text rendered with underline at cursor
- [x] Input sink with proper font metrics for IME candidate positioning
- [ ] Test with Japanese/Chinese/Korean IME (manual)

### 5.3 Accessibility
- [ ] Screen reader support (ARIA, live regions)
- [ ] High-contrast theme
- [x] Configurable cursor blink

### 5.4 Bell and Notifications
- [ ] BEL visual/audio bell
- [ ] OSC 9/777 desktop notifications
- [ ] Dock icon bounce on bell

---

## Phase 6 — Performance and Architecture — FUTURE

### 6.1 Web Worker Rendering
- [ ] OffscreenCanvas in Web Worker

### 6.2 WebGL Renderer
- [ ] IRenderer WebGL backend with instanced quad rendering

### 6.3 Benchmarking Suite
- [ ] Throughput, render, input latency benchmarks
- [x] Debug overlay (Cmd+Shift+D) with draw time, atlas stats, throughput

---

## Phase Summary

```
Phase 1 — Daily Driver        COMPLETE (code done, manual app testing open)
Phase 2 — Comfort             COMPLETE (hot-reload, keybindings, opacity open)
Phase 3 — Multi-Terminal       COMPLETE
Phase 4 — Rich Content        FUTURE (image protocols, font fallback, ligatures)
Phase 5 — Platform/A11y       PARTIAL (IME done, cross-platform/a11y/bell open)
Phase 6 — Performance         FUTURE (Web Worker, WebGL, benchmarks)
```
