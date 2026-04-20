# Leftover Follow-up Items

Collected from Terminal Trust Hardening, Prompt Queue, and Feature Roadmaps (2026-04-19). Manual testing, documentation, and future code items that remain after the main code work was completed.

---

## Manual Testing

### Lifecycle QA Re-tests
- [ ] Re-test Test 7: Tab close with multiple panes (fixed via TerminalHost cache)
- [ ] Re-test Test 11: Rapid `yes` + close (disposed guards added)
- [ ] Run Test 12: Close pane during shell startup

### Persistence Stress Testing
- [ ] Open/close/switch tabs repeatedly and profile save frequency
- [ ] Split/close panes repeatedly and profile save frequency
- [ ] Verify autosave under heavy PTY activity
- [ ] Verify no corrupted session file on interrupted writes

### IME Validation
- [ ] Test Japanese IME
- [ ] Test Chinese IME
- [ ] Test accented Latin composition
- [ ] Test mixed terminal/TUI scenarios

### Escape Sequence Testing (real apps)
- [ ] Run Vim/Neovim — fix any rendering, cursor, or mode issues
- [ ] Run htop — verify alternate screen, color rendering, mouse interaction
- [ ] Run tmux — test nested terminal handling, status bar, pane splits
- [ ] Run Claude Code — stress-test rapid output, SGR sequences, bracketed paste
- [ ] Run less/man — verify scrollback, alternate screen entry/exit
- [ ] Run nano — basic editing, status line
- [ ] Run git log/diff with color — verify 256-color and truecolor output

### Prompt Queue
- [ ] Verify queue state survives app restart and session restore

### OSC 52 Clipboard
- [ ] Test with programs that use OSC 52 (Neovim clipboard integration)
- [ ] Security: consider restricting clipboard access per-application

---

## Documentation

### Input Limitations
- [x] Document what input modes are supported
- [ ] Remove composition warning only once support is verified reliable

### User-Facing Honesty
- [x] Make sure README and product copy do not overstate session behavior
- [x] Make sure close behavior is discoverable
- [x] Make sure limitations are stated where they matter

### Prompt Queue
- [x] Document queue behavior in the README once stable

---

## Minor Code Items

### Session
- [x] Ensure session landing UI reflects what is actually restored (layout vs shell records)
- [x] Handle deleted files and moved directories gracefully (editor panes with missing files)
- [x] Add migration rules for older session file formats

### Config System
- [ ] Hot-reload: watch config file and apply changes without restart
- [ ] Custom keybindings in config
- [ ] Window opacity setting
- [ ] CLI flag to specify config path (`--config`)

### URL Detection
- [ ] Handle URL wrapping across multiple lines

### Reflow
- [ ] Handle reflow in scrollback (soft-wrapped rows in history should rejoin)

### Prompt Library
- [ ] Tags, folders, or lightweight categories for prompts
- [ ] Import/export for prompt libraries

### Backend/PTY Test Coverage (needs Tauri runtime)
- [ ] Add tests for shell spawn failure and recovery
- [ ] Add tests for pane close cleanup behavior
- [ ] Add tests for cwd lookup behavior
- [ ] Add tests for foreground process title lookup behavior

### End-to-End Smoke Coverage (needs E2E tooling)
- [ ] Launch app and open a shell
- [ ] Create a second tab at the same cwd
- [ ] Split panes and close one
- [ ] Save and restore a named session
- [ ] Open Prompt Stacker and save a prompt
- [ ] Flip to explorer and open a markdown file

---

## Future Roadmap Items (Phase 4-6)

### Rich Content (Phase 4)
- [ ] Kitty graphics protocol
- [ ] Sixel graphics
- [ ] iTerm2 inline images (OSC 1337)
- [ ] Font fallback chain with color emoji support
- [ ] Ligature support for programming fonts

### Platform and Accessibility (Phase 5)
- [ ] Windows build and test (ConPTY, keybindings, font rendering)
- [ ] Linux build and test (Wayland/X11, fontconfig, IBus/Fcitx)
- [ ] CI pipeline for all three platforms
- [ ] Screen reader support (ARIA, live regions)
- [ ] High-contrast theme
- [ ] BEL visual/audio bell
- [ ] OSC 9/777 desktop notifications
- [ ] Dock icon bounce on bell

### Performance and Architecture (Phase 6)
- [ ] Web Worker rendering with OffscreenCanvas
- [ ] WebGL renderer (IRenderer backend, instanced quad rendering)
- [ ] Benchmarking suite (throughput, render, input latency)
