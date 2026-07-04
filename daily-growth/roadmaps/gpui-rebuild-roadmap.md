# t-bias — GPUI Rebuild Roadmap

**Goal:** Rebuild t-bias as a fully native, GPU-accelerated **Rust desktop app** with no
webview, no JS bridge, no external runtime. Terminal emulation via `alacritty_terminal`,
UI via **GPUI** (Zed's framework), shells via `portable-pty`. This is Zed's own terminal
architecture applied to a standalone app.

**Why this stack:** A terminal's hard constraint is that the UI framework must own glyph
rasterization end-to-end (shaping, atlas, GPU draw). GPUI does. Everything else (native
window, one process, one language, no webview "won't open" class of bugs) follows from
that. Proven: Zed's built-in terminal is GPUI + `alacritty_terminal`.

---

## Locked stack (decisions)

- [ ] **UI framework:** GPUI — git dependency on `zed-industries/zed` (not on crates.io yet).
- [ ] **UI component library:** `gpui-component` (longbridge) for chrome (tabs, resizable
      panels, buttons, lists, scrollbars). Terminal grid is hand-written (must be).
- [ ] **Terminal backend:** `alacritty_terminal = "0.26"` (off Zed's internal fork).
- [ ] **PTY:** `portable-pty = "0.8"` (reuse existing `sidecar/`/old `pty.rs` logic).
- [ ] **Persistence:** `rusqlite` (bundled SQLite) — direct, in-process, no ORM.
- [ ] **Platform:** macOS-first (GPUI's strongest target); Linux/Windows deferred.
- [ ] **Repo strategy:** build the new app in a fresh crate (`app/` or repo-root Cargo
      project) **alongside** the current Deno app; do not delete Deno code until parity.
- [ ] **Edition/toolchain:** Rust 2021, current stable (verified: cargo 1.94 present).

### References (consult during build)
- [ ] Zed terminal source: `crates/terminal/src/terminal.rs`,
      `crates/terminal_view/`, `crates/terminal/src/terminal_element/` (canonical pattern).
- [ ] GPUI docs: https://www.gpui.rs/ and `docs.rs/gpui`.
- [ ] gpui-component getting started: https://longbridge.github.io/gpui-component/docs/getting-started
- [ ] `alacritty_terminal` docs: https://docs.rs/alacritty_terminal
- [ ] Walkthrough: "Building a native terminal in Rust + GPUI" (dev.to / arthurj-dev).

---

## Phase 0 — Scaffold & toolchain

- [x] Confirm toolchain: `rustc --version`, `cargo --version` (stable, ≥1.80). → cargo 1.94.1, rustc 1.94.1 initially; bumped to **1.95.0** (see below) — pinned via `app/rust-toolchain.toml`.
- [x] Install/verify system deps for GPUI on macOS. → CLT alone hits a snag by default:
      `gpui_macos`'s build script shells out to `xcrun -f metal` to compile a Metal shader at
      build time, and that `metal` CLI compiler only ships with full Xcode.app. **Fix: no Xcode
      needed** — `gpui_macos`/`gpui_platform` expose a `runtime_shaders` feature that stitches
      the header + `.metal` source into one file and compiles it at *runtime* via the Metal
      *framework* (`MTLDevice newLibraryWithSource`), which is part of the OS, not Xcode. Enabled
      via `gpui_platform = { ..., features = ["runtime_shaders"] }` in `Cargo.toml`. CLT alone is
      sufficient with this flag.
- [x] Create new crate dir (decide: repo-root `Cargo.toml` vs `app/`). → chose `app/`.
- [x] `cargo init` the binary crate; set package name `t-bias`, edition 2021.
- [x] Work on a branch: `gpui-rebuild`.
- [x] Add dependencies to `Cargo.toml` (started minimal — gpui + alacritty + portable-pty;
      gpui-component/rusqlite/serde added in later phases to keep Phase 0 lean):
  - [x] `gpui = { git = "https://github.com/zed-industries/zed", rev = "1a99eba1..." }`
  - [x] `gpui_platform` — required earlier than planned: at this rev `Application::new()` doesn't
        exist; `gpui_platform::application()` is the only way to get a per-OS `Platform` impl
        (see `crates/gpui_platform/src/gpui_platform.rs` in the Zed tree). `gpui-component` /
        `gpui-component-assets` still deferred to Phase 4 (chrome).
  - [x] `alacritty_terminal = "0.26"`
  - [x] `portable-pty = "0.8"`
  - [ ] `rusqlite = { version = "0.32", features = ["bundled"] }` — deferred to Phase 5
  - [x] `anyhow`, `log` (serde/dirs/libc added when needed)
- [x] Pin the exact Zed git rev for `gpui`/`gpui_platform`: **`1a99eba1926a2776cfb39be3dca922cf08483af7`**
      (was already the version `Cargo.lock` had resolved; pinned it explicitly with `rev =` in
      `Cargo.toml` so it can't silently drift to `main`).
- [x] Write minimal `main.rs`: `gpui_platform::application().run()` → `open_window` → root view.
      (Not `Application::new()` — see note above; that constructor isn't in this rev's public API.)
- [ ] (using plain gpui for Phase 0; `gpui_component::init` deferred with the component lib)
- [x] `cargo build` a "hello window" — **succeeds**, CLT only (no Xcode.app). Three real issues
      fixed getting here: (1) rustc 1.94 rejects `std::hint::cold_path` as unstable — Zed's own
      `rust-toolchain.toml` pins stable **1.95.0**, which stabilizes it, so `app/rust-toolchain.toml`
      now pins the same; (2) `Application::new()` doesn't exist at this rev →
      `gpui_platform::application()`; (3) `gpui_macos`'s build-time Metal shader compile needs
      full Xcode → enabled `runtime_shaders` feature to compile shaders at runtime instead.
- [x] **VERIFY:** `cargo run` opens a real native window showing text. ✅ Spine of the shell.
      Confirmed: process launches and stays up, macOS registers a `t-bias` window/process
      (`osascript` process-list check), clean shutdown on kill.
- [x] Commit: `feat(gpui-0): scaffold native GPUI window`.

## Phase 1 — PTY + alacritty spine (ONE live terminal) ⚠️ make-or-break — DONE

- [x] Create the terminal module → `app/src/terminal.rs` (single file for now; split later).
- [x] Define the alacritty `EventListener` impl (`TbiasListener`) wrapping an
      `UnboundedSender<AlacEvent>` (channel to the GPUI main thread). Uses
      `futures::channel::mpsc::unbounded` (added `futures = "0.3"` dep) — receiver is a `Stream`
      awaitable in a gpui task; sender is `Send + Sync` for the emulation layer.
- [x] Create `Term<TbiasListener>` with `term::Config::default()` + initial size.
      Note: `TermSize` lives in `alacritty_terminal::term::test`; defined our own
      `TerminalSize` implementing `grid::Dimensions` instead of leaning on the test helper.
- [x] Wrap shared state as `Arc<FairMutex<Term<TbiasListener>>>` (`alacritty_terminal::sync`).
- [x] Spawn shell via `portable-pty`: `native_pty_system().openpty()`, `CommandBuilder`
      (login shell `-l`, `TERM=xterm-256color`, `COLORTERM=truecolor`, cwd=`$HOME`). Note:
      `CommandBuilder::new` seeds env from `std::env::vars_os()`, so PATH etc. are inherited.
      Drop the slave after spawn so the master read hits EOF on child exit.
- [x] Implement `pty_reader_loop` (detached thread):
  - [x] Read PTY into a 4096-byte buffer.
  - [x] `processor.advance(&mut *term.lock(), &buf[..n])` — parser is
        `alacritty_terminal::vte::ansi::Processor::<StdSyncHandler>` (needs the explicit
        `Timeout` type param; `Term` impls `vte::ansi::Handler`).
  - [x] Emit `AlacEvent::Wakeup` after each parse pass. (We drive the parser by hand, so we
        emit our own wakeups; alacritty's own `event_loop` would otherwise do this. Redundant
        wakeups during synchronized-output windows are harmless — refine in Phase 2.)
  - [x] Break on read 0 / error, then emit `AlacEvent::Exit`.
- [x] Implement `pty_message_loop` (detached thread): receive `Msg` over `std::sync::mpsc`
      (`Input(bytes)` → write+flush, `Resize(size)` → `master.resize`, `Shutdown` → `child.kill`).
      `Terminal`'s `Drop` sends `Shutdown` so the shell is killed when the pane goes away.
- [x] Bridge the `AlacEvent` receiver to GPUI via `cx.spawn` async loop: `events.next().await`
      then drain queued events with `try_recv`, coalescing a burst into one `cx.notify()`.
      (Simplified the "4 ms / 100 events" budget to burst-coalescing for Phase 1; revisit under
      load in Phase 2.)
- [x] Handle `AlacEvent::Exit` / `ChildExit` → `terminal.mark_exited()` + notify; UI shows
      `[shell exited]`.
- [x] **VERIFY:** ✅ Window opens with a live login shell. Rendering is a naive per-line text
      dump (`visible_lines()`) — Phase 2 replaces it with a real cell element. Confirmed the full
      PTY → VTE → Term → UI path by driving two startup commands and reading back the parsed
      grid: real zsh prompt, `echo` output, and `uname -a` + `ls` listing all present. Clean
      build (CLT only), app launches and stays up.
- [x] Commit: `feat(gpui-1): PTY + alacritty_terminal spine`.

  Follow-ups deferred to later phases: pixel size in `TermSize` for full-screen apps (P2),
  wakeup batching budget under load (P2), real keyboard input replaces the hardcoded startup
  commands (P3).

## Phase 2 — Terminal rendering (TerminalElement)

- [ ] Create `terminal/element.rs` implementing a GPUI `Element` for the grid.
- [ ] Choose + load a monospace font (font-kit); expose font family + size.
- [ ] Measure cell size (advance width, line height) from the font at current size.
- [ ] In `render`, read `term.lock().renderable_content()` for visible cells.
- [ ] Draw background rects per cell (batch runs of same bg color to cut draw calls).
- [ ] Draw glyphs per cell with fg color (let GPUI own shaping/atlas).
- [ ] Map alacritty colors → RGBA:
  - [ ] 16 ANSI colors + bright variants.
  - [ ] 256-color cube.
  - [ ] 24-bit truecolor.
  - [ ] Named/default fg/bg from a theme struct.
- [ ] Text attributes: bold, italic, underline, strikethrough, dim, inverse, hidden.
- [ ] Render cursor: shape (Block/Beam/Underline), focused vs unfocused (hollow), blink.
- [ ] Implement blink timer (BlinkManager equivalent) tied to `cx` timers.
- [ ] Handle wide (CJK) glyphs + zero-width / combining marks.
- [ ] Compute grid size from element bounds → cols/rows; send `Resize` to PTY + `term.resize()`.
- [ ] Debounce resize; keep PTY `TermSize` and element in sync (incl. pixel size for apps).
- [ ] **VERIFY:** run `vim`, `htop`, `ls --color`, a 256/truecolor test script, a CJK
      string — all render correctly and reflow on window resize. ✅
- [ ] Commit: `feat(gpui-2): terminal cell rendering`.

## Phase 3 — Input (keyboard, mouse, clipboard)

- [ ] Focus handling: element is focusable; track focused pane.
- [ ] Key events → bytes: printable chars, Enter, Backspace, Tab, Esc.
- [ ] Control/Alt/modifier encoding (Ctrl-C, Ctrl-D, Ctrl-Z, Alt-sequences).
- [ ] Arrow/Home/End/PageUp/Down/Delete/Insert/Function keys (application vs normal mode).
- [ ] Respect terminal modes (application cursor keys, bracketed paste).
- [ ] Bracketed paste: wrap pasted text in `\e[200~ … \e[201~`.
- [ ] Mouse: click to focus, click-drag selection, cell hit-testing.
- [ ] Selection model: start/extend/word/line select; render selection highlight.
- [ ] Copy selection → system clipboard (gpui clipboard API).
- [ ] Paste from clipboard → PTY (with bracketed-paste if enabled).
- [ ] Mouse reporting mode passthrough (so TUIs get mouse events when they ask).
- [ ] Scroll: wheel scrolls scrollback (viewport), not the shell, in normal mode.
- [ ] IME / dead keys / composition input.
- [ ] **VERIFY:** Claude Code, vim, tmux, less, a mouse-driven TUI all usable; copy/paste
      works; IME (if applicable) composes. ✅
- [ ] Commit: `feat(gpui-3): terminal input, selection, clipboard`.

## Phase 4 — Workspace shell (tabs, splits, zoom)

- [ ] Port `pane-tree` model to Rust: `Pane` enum (Terminal / Explorer / Split), `PaneMap`.
- [ ] Port tree ops: `split_pane`, `close_pane`, `find_adjacent`, `leaf_ids`, DFS order.
- [ ] Unit tests for tree ops (mirror the TS behavior).
- [ ] Workspace state entity: tabs, active tab, active pane, per-tab pane tree, zoom, nextId.
- [ ] Terminal session cache keyed by pane id (session survives split/zoom re-layout).
- [ ] Tab bar UI (gpui-component tabs): add/close/select/reorder, active styling.
- [ ] Split rendering: recursive layout with draggable dividers (h/v), ratio clamp [0.1,0.9].
- [ ] Divider drag → update ratio → relayout (use `Rc<Cell<f32>>` for drag state).
- [ ] Zoom: render only active pane when zoomed; background shells keep running.
- [ ] Pane focus ring + click-to-activate.
- [ ] Keybindings: new/close tab, split h/v, zoom, cycle tabs, select tab N, navigate panes,
      font zoom in/out/reset.
- [ ] Shell-exit handling: pane whose shell exits collapses; last pane closes tab.
- [ ] **VERIFY:** open several tabs, split panes both directions, drag dividers, zoom,
      navigate with keyboard, close panes — all stable; background shells stay alive. ✅
- [ ] Commit: `feat(gpui-4): tabs, splits, zoom`.

## Phase 5 — Persistence (SQLite)

- [ ] Choose app-data dir (`~/Library/Application Support/com.tbias.app`).
- [ ] `db` module: open `rusqlite` connection (bundled), create dir if missing.
- [ ] Migrations: `workspaces`, `tabs`, `panes` (self-ref tree), `shells` tables.
- [ ] Serialize workspace snapshot → rows (recompute pane `parent_id` from tree).
- [ ] Deserialize rows → workspace state (find root = pane with no parent).
- [ ] Save: debounced autosave on layout change + save on quit (window close event).
- [ ] Load/hydrate on startup; fall back to a fresh single-tab workspace.
- [ ] Shell records: insert on spawn (pid/command/cwd), update on exit (status/code).
- [ ] Track per-pane cwd (OSC 7 / process cwd) for restore + titles.
- [ ] **VERIFY:** lay out tabs/splits, quit, relaunch → layout restored; shell history in DB. ✅
- [ ] Commit: `feat(gpui-5): SQLite persistence`.

## Phase 6 — File explorer + flip explorer

- [ ] `fs` module: sandboxed list/read (root guard), sorted dirs-first.
- [ ] Explorer pane UI: header (path, up button) + scrollable entry list (gpui-component list).
- [ ] Icons per type (dir/file/symlink/markdown).
- [ ] Navigate into dirs; up-navigation; keyboard nav (optional).
- [ ] Flip explorer: toggle a leaf between terminal ↔ explorer in place (keep session cached).
- [ ] Open file behavior: `.md` → Phase 7 preview; others → (future editor or ignore).
- [ ] **VERIFY:** browse dirs, flip a terminal to explorer and back, open a file. ✅
- [ ] Commit: `feat(gpui-6): file explorer + flip`.

## Phase 7 — Markdown preview (port the feature we just built)

- [ ] Port `renderMarkdown` logic to Rust (or use `pulldown-cmark` + safe HTML-free render).
- [ ] Decide render approach in GPUI: build GPUI element tree from parsed MD (no HTML).
- [ ] Support: headings, bold/italic/strike, inline + fenced code, lists (nested), links,
      images, blockquotes, rules, GFM tables.
- [ ] Live font-size control (A− / reset / A+).
- [ ] Display-style skins: Default, Newspaper, Invoice, Diagram (theme structs, not CSS).
- [ ] Toolbar: back-to-files, filename, style selector, font controls.
- [ ] Open `.md` from explorer → preview; back returns to listing.
- [ ] **VERIFY:** render a complex `.md`, switch styles, change font size. ✅
- [ ] Commit: `feat(gpui-7): markdown preview`.

## Phase 8 — Config, theming, keybindings

- [ ] Config file (TOML) in app-data dir; load on startup, sensible defaults.
- [ ] Theme system: terminal palette + UI colors; ship 2–3 presets (dark default).
- [ ] Font config (family, size, line-height) applied to terminal + UI.
- [ ] Window opacity / padding options.
- [ ] Customizable keybindings map (config-driven), with defaults.
- [ ] Config hot-reload (watch file) — optional.
- [ ] Native app menu (About / Quit / Edit menu / view actions).
- [ ] **VERIFY:** edit config, restart (or hot-reload), see theme/font/keybinding changes. ✅
- [ ] Commit: `feat(gpui-8): config, theming, keybindings`.

## Phase 9 — Prompt stacker (port from old Tauri app)

- [ ] Recover design from git history (`prompt_stacker.rs`, old frontend).
- [ ] Data model: saved prompts, tags, ordering; SQLite table.
- [ ] UI: save/search/queue prompts, tags, import/export.
- [ ] Send-to-terminal (write prompt text to active pane's PTY).
- [ ] **VERIFY:** save, search, queue, send a prompt. ✅
- [ ] Commit: `feat(gpui-9): prompt stacker`.

## Phase 10 — Infinite canvas (port from old app) — OPTIONAL

- [ ] Decide whether canvas is in scope for v1.
- [ ] Canvas surface: pan/zoom, rects, connectors, text, marker/lasso tools.
- [ ] Persist canvas state.
- [ ] **VERIFY:** draw, connect, label, pan/zoom, persist. ✅
- [ ] Commit: `feat(gpui-10): canvas`.

## Phase 11 — Packaging & distribution (macOS)

- [ ] App bundling: `.app` structure (Info.plist, icon set, bundle id `com.tbias.app`).
- [ ] Choose bundler (`cargo-bundle` / `cargo-packager` / hand-rolled) — record choice.
- [ ] Bundle the binary + resources (fonts, assets) into the `.app`.
- [ ] Code signing (Developer ID) + hardened runtime + entitlements.
- [ ] Notarization + stapling.
- [ ] DMG or zip for distribution.
- [ ] Launch-from-Finder smoke test (env inheritance: login shell resolves PATH).
- [ ] Auto-update strategy (deferred; record the plan).
- [ ] **VERIFY:** double-click the built `.app` on a clean profile → app runs, terminals work. ✅
- [ ] Commit: `feat(gpui-11): macOS packaging`.

## Phase 12 — Cross-platform (OPTIONAL, later)

- [ ] Linux build (GPUI Blade/Vulkan backend) — assess maturity.
- [ ] Windows build — assess maturity.
- [ ] Per-platform PTY/clipboard/menu differences.

## Phase 13 — Cutover & cleanup

- [ ] Feature-parity checklist vs current Deno app signed off.
- [ ] Remove Deno app: `main.ts`, `pty_bridge.ts`, `db/*.ts`, `fs/sandbox.ts`, `deno.json`,
      `deno.lock`, `sidecar/` (if fully absorbed), Vite/SolidJS `src/`, `package.json`,
      `bun.lock`, `index.html`, `vite.config.ts`.
- [ ] Update `README` + project memory to reflect the GPUI architecture.
- [ ] Archive this roadmap to `daily-growth/roadmaps/old-maps/` when complete.

---

## Working principles

- [ ] **De-risk order:** windowing → PTY spine → rendering → input → workspace → the rest.
      Do NOT build chrome before a live terminal renders and accepts input.
- [ ] **Keep the Deno app runnable** (browser dev) until GPUI reaches parity — no early deletion.
- [ ] **Verify each phase in the real app** (run real TUIs), not just `cargo build`.
- [ ] **Commit per phase** with the tags above; keep phases independently reviewable.
- [ ] **Pin GPUI's git rev**; bump deliberately, never track `main` blindly.
- [ ] **Single-threaded render tree:** UI state via `Entity<T>` + `cx.notify()`; use
      `Rc<Cell<_>>` for transient UI state, `Arc<FairMutex<_>>` only for the shared `Term`.
