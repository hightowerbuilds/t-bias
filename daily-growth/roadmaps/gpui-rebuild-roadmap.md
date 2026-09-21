# t-bias — Native GPUI roadmap

**Updated 2026-09-20. Native implementation and local packaging complete; Developer ID signing complete, notarization awaits a keychain profile.**

The native roadmap takes priority over controller development. Existing controller input is preserved and routed to the active pane; new controller features remain in the [controller roadmap](ps2-terminal-roadmap.md).

The original phase-by-phase plan and historical verification notes are preserved in [the July plan](old-maps/gpui-rebuild-plan-2026-07.md). This document describes the current implementation rather than the superseded Metal/git-dependency experiments.

## Stack and scope

- [x] Rust 1.95.0, edition 2021, native macOS app in `app/`.
- [x] Published `gpui = "=0.2.2"` with `macos-blade`. This renderer is required on the Intel/AMD development Mac; no Xcode Metal compiler is needed.
- [x] `alacritty_terminal = "0.26"`, `portable-pty = "0.8"`, bundled `rusqlite`.
- [x] Native GPUI elements for tabs, dividers, menus, explorer, Markdown, and prompt editor. Decision: retain the existing GPUI element approach rather than add another component framework.
- [x] macOS native delivery first. Infinite canvas and Linux/Windows remain explicitly optional follow-ups.

## Phases 0–3 — Terminal and input

- [x] Native window, login shell, separate PTY reader/writer threads, coalesced foreground updates.
- [x] Terminal responses (`PtyWrite`, color queries, text-area-size queries), titles, exit handling.
- [x] Grid rendering with ANSI/256/truecolor, attributes, wide characters, combining marks, selection highlighting, scrollback offsets, and live palette changes.
- [x] Focused/unfocused cursors, block/beam/underline shapes, blink, font measurement, grid and pixel PTY resize.
- [x] Keyboard control/function/navigation keys and configurable app shortcuts.
- [x] Native IME composition and dead keys, UTF-16 input handling, bracketed paste.
- [x] Mouse selection, word/line/block selection, copy, and legacy/UTF-8/SGR TUI mouse reports. Shift bypasses TUI capture for local selection.
- [x] Shell lifecycle cleanup and reaping on pane close/quit; shell records tracked.
- [x] **Verified:** actual shell command execution, selection/copy, Vim, less, and tmux in the real GPUI window. Native editor dead-key composition saved `Café` correctly. Mouse protocols have unit coverage.

## Phases 4–5 — Workspace and persistence

- [x] Ordered tabs, active styling, add/close/select/reorder.
- [x] Recursive horizontal/vertical splits, draggable dividers, ratio clamping, active pane borders.
- [x] Zoom and pane/tab keyboard navigation.
- [x] Session cache keyed by `(tab_id, pane_id)`; hidden panes and tabs retain shells.
- [x] Shell exits collapse panes; closing the last tab creates a fresh shell.
- [x] SQLite restore on startup, 500 ms debounced autosave, periodic cwd capture, final save on window close and quit.
- [x] Persist layout, working directories, active tab/pane, zoom, and ID allocators. Validate persisted graphs before recursive rendering.
- [x] **Verified:** real-window smoke exercises layout operations, session PID survival, SQLite round-trip, and pane closing. Quit/relaunch restores the saved layout with fresh shells. Test shell PIDs are gone after quit.

## Phases 6–7 — Files and Markdown

- [x] Explorer follows shell cwd and anchors at the nearest Git repository.
- [x] Directory navigation, keyboard arrows/Enter/Backspace/Escape, animated terminal/explorer flip.
- [x] Root-clamped paths plus canonical-path checks for symlink escapes.
- [x] Native Markdown headings, emphasis, lists, code, quotes, tables, links, and image-link labels.
- [x] Font controls and Default/Newspaper/Invoice/Diagram display styles.
- [x] **Verified:** existing visual explorer verification plus current native smoke parsing and rendering `README.md`; parser and filesystem tests pass.

## Phase 8 — Configuration and desktop integration

- [x] `config.toml` in the app-data directory; defaults created on first launch, invalid values reported without overwriting the file.
- [x] Dark, light, and Dracula themes; font family/size, line height, padding, opacity, cursor blink.
- [x] Configurable action shortcuts; `option_as_meta` controls native Option-key composition versus terminal Meta encoding.
- [x] Native About/Quit/File/Edit/View menus and Settings entry.
- [x] Startup/error logging to stderr and a rotating app-data log.
- [x] Configuration validation tests. Restart applies configuration; live reload remains an optional follow-up.

## Phase 9 — Prompt library

- [x] Recover the previous prompt-library/queue design from Git history.
- [x] SQLite-backed prompt text, tags, ordering, and queue.
- [x] Native multiline editor, selection, clipboard, caret, and IME composition.
- [x] Save/edit/delete/duplicate/search, tags, enqueue/remove/reorder/clear.
- [x] Import/export with native file dialogs; compatible with previous state-object and legacy-array JSON formats.
- [x] Send or send-next inserts text into the active terminal without submitting Enter; send-next advances the queue.
- [x] **Verified:** actual pointer/keyboard creation and SQLite persistence of a multiline prompt and composed Unicode text; tests cover persistence, queue order, tag normalization, and legacy import.

## Phase 11 — macOS packaging

- [x] Reproducible `.app` structure, native icon, Info.plist, bundle ID `com.tbias.app`.
- [x] `scripts/package-native.sh`: optimized binary, resources, signed bundle, ZIP.
- [x] Local ad-hoc signature verified; bundled app launched through macOS Launch Services with isolated data and passed the native smoke test.
- [x] Final Developer ID signature, Apple certificate chain, secure timestamp, hardened runtime, and resource seal verified outside the sandbox. The signed bundle also passed Launch Services smoke.
- [ ] Notarization/stapling: need the existing `notarytool` keychain profile name (or credentials configured locally). The Developer ID certificate is available outside the sandbox.
- [x] Auto-update decision: manual bundle replacement for this release; signed automatic updates deferred.

## Phase 13 — Native cutover

- [x] Native equivalents for the old app's terminal, tabs, splits, workspace persistence, explorer, and Markdown styles.
- [x] Remove the Deno/SolidJS/xterm source and PTY sidecar from the active tree.
- [x] Preserve all 38 retired source files, including existing uncommitted Deno work, in `legacy/deno-source-2026-09-20.tar.gz`; verify every file's SHA-256 before removing its original.
- [x] Preserve existing legacy SQLite data. No implicit migration into the different native schema.
- [x] README with architecture, commands, shortcuts, configuration, packaging, and verification.
- [x] Repeatable `scripts/check-native.sh`, plus `--gui` for real-window smoke coverage.
- [x] Commit the native completion checkpoint.

## Verification record

- `cargo test --offline`: **59 passed**.
- Debug and optimized builds succeeded.
- Expanded `--smoke-test`: **NATIVE_SMOKE_OK** — shell input, selection/copy, splits, zoom, tabs, PID survival, SQLite restore, prompts, flip, close, Vim, less, tmux, Markdown, natural shell exit and pane collapse.
- Packaged Launch Services smoke passed; native pointer/keyboard prompt editor and dead-key composition checked separately.
- Local archive approximately 4.6 MB, native executable approximately 10 MB before final signed rebuild.

## Explicit follow-ups

- Notarize/staple with the user's existing keychain profile.
- Controller text entry, modes, overlays, haptics, and remapping remain on the separate controller roadmap.
- Infinite canvas, Linux/Windows, config live reload, and automatic updates are deferred optional work.
- Broader hardware/OS coverage, long-duration TUI workloads, and additional IME languages remain release validation work beyond the checks above.
