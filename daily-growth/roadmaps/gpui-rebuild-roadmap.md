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

> **CRITICAL (2026-07-04):** Use the **published `gpui = "=0.2.2"` from crates.io with the
> `macos-blade` feature** — NOT the git dep and NOT the default Metal backend. The Metal backend
> (`gpui_macos`) renders only solid quads on this Intel/AMD dual-GPU Mac (macOS Tahoe 26) —
> **all glyphs are invisible**. The Blade renderer (wgpu/naga) renders text correctly AND needs
> no Xcode/`xcrun metal` (naga compiles shaders). Entry point is `gpui::Application::new()`.
> Diagnosed by comparing against the user's working repo `hightowerbuilds/llnzy`.

- [ ] ~~**UI framework:** GPUI — git dependency on `zed-industries/zed`.~~ → **`gpui = "=0.2.2"`
      (crates.io) + `features = ["macos-blade"]`.** See critical note above.
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

## Phase 2 — Terminal rendering (TerminalElement) — DONE

Chose GPUI's built-in `canvas(prepaint, paint)` element over a hand-rolled `Element` impl — it
gives the low-level paint API (bounds → `paint_quad` / `shape_line`) without the trait
boilerplate, which is exactly what a grid needs. All in `app/src/terminal_view.rs`.

- [x] Grid element implemented via `canvas`; `terminal_element(handle, family, size, theme)`.
- [x] Monospace font via `gpui::font(family)` (Menlo, 14px); family/size are parameters.
- [x] Measure cell size: `text_system().advance(font_id, size, 'm').width` for cell width;
      line height = `size * 1.3`. (Font-kit not needed — gpui's text system owns metrics.)
- [x] Read `term.lock().renderable_content()` each paint; snapshot the grid + cursor into owned
      data and **drop the lock before painting** (don't hold the FairMutex across shaping).
- [x] Background rects: coalesce contiguous runs of the same non-default bg into one `fill` quad.
- [x] Glyphs: one `shape_line` per row (GPUI owns shaping/atlas), painted at the row origin.
- [x] alacritty colors → RGBA: 16 ANSI + bright, 256 cube (steps 0/95/135/175/215/255) +
      grayscale ramp, 24-bit truecolor (`Color::Spec`), named/default fg/bg/cursor from a
      `Theme` struct (GitHub-dark palette; `bg` matches the window).
- [x] Attributes: bold (+ bold-is-bright for ANSI 0-7), italic, underline (any underline flag),
      strikethrough, dim (×0.66), inverse (swap fg/bg), hidden (fg=bg).
- [~] Cursor: hollow box (`outline`) for now — correct-looking regardless of focus. Focused
      solid/inverted block + shape (Block/Beam/Underline) + blink deferred to Phase 3 (needs
      focus tracking) / a blink timer.
- [x] Wide (CJK) glyphs: skip `WIDE_CHAR_SPACER` / `LEADING_WIDE_CHAR_SPACER` cells so the wide
      glyph takes its natural 2-cell advance. (Zero-width/combining marks: basic; refine later.)
- [x] Compute cols/rows from the element's painted bounds in `prepaint`; `handle.resize_to()`
      reflows both `term.resize()` and the PTY (`Msg::Resize`), no-op when unchanged.
- [~] Resize is idempotent per-frame (no-op when dims match) rather than time-debounced; pixel
      size still 0 in `TermSize` (full-screen apps that query pixel size — deferred).
- [x] **VERIFY:** ⚠️ screen capture is blocked in this environment, so verified headlessly: the
      paint path runs without panic across 16-color SGR, bold-bright, underline, inverse, 24-bit
      truecolor, `ls --color=always`, and CJK wide chars; and the grid **reflows** to fill the
      window (initial 100×30 → 44 rows + wider cols, confirmed by a long `uname` line no longer
      wrapping). Pixel-accurate visual confirmation (vim/htop looking right on screen) still
      pending a screenshot — data + paint-call path proven, but eyes-on is a TODO.
- [x] Commit: `feat(gpui-2): terminal cell rendering`.

## Phase 3 — Input (keyboard, mouse, clipboard)

### 3a — Keyboard, scroll, paste, focus — DONE (commit `feat(gpui-3a)`)

Key encoding is a pure, unit-tested function in `app/src/input.rs` (`encode_key`) so the fiddly
control-code / CSI / app-cursor / modifier logic is pinned by tests, not eyeballed.

- [x] Focus: `Root` holds a `FocusHandle`; container div `.track_focus()` + focused on first
      paint (`window.focus`). Focused state flows to the element (solid cursor when focused).
- [x] Key events → bytes: printable (via `key_char`), Enter (`\r`), Backspace (`0x7f`), Tab
      (`\t` / back-tab `ESC[Z`), Esc.
- [x] Control/Alt/modifier encoding: Ctrl-<letter> → 0x01-0x1a (+ symbol controls, Ctrl-Space =
      NUL), Alt → ESC-prefix.
- [x] Arrows/Home/End/PageUp-Down/Delete/Insert/F1-F12; application-cursor mode swaps `ESC[` for
      `ESC O`; a held modifier forces the CSI form with the `1;{mod}` parameter.
- [x] Respect terminal modes: `TermMode::APP_CURSOR` for arrows, `BRACKETED_PASTE` for paste.
- [x] Bracketed paste: ⌘V reads the clipboard, normalizes newlines→CR, wraps in
      `ESC[200~ … ESC[201~` when the app enabled it.
- [x] Scroll: wheel → `term.scroll_display(Scroll::Delta)`; keypress jumps back to the live
      prompt (`Scroll::Bottom`).
- [x] Focused cursor: solid block with the glyph redrawn in bg (inverted); hollow when unfocused.
- [x] Removed the hardcoded startup demo commands — the app now opens to a live, typeable prompt.
- [x] **VERIFY:** `encode_key` unit tests (7, all pass) cover printable/Ctrl/Alt/arrows-app-vs-
      normal/edit+function/⌘-not-sent. End-to-end wiring verified by synthesizing keystrokes
      through the real `on_key` path (keystroke → encode → PTY → shell): typed
      `echo INPUT_OK && ls | head -3`, shell executed it, output landed in the grid. (Physical
      key delivery is gpui's `on_key_down`; can't drive it headlessly, but the encode+plumbing
      path is proven.)

### 3b — Mouse selection + copy (remaining)

- [ ] Mouse: click to focus/position, click-drag selection, cell hit-testing (needs the last
      painted grid metrics: bounds origin + cell size — stash them for the mouse handler).
- [ ] Selection model: start/extend/word/line select (alacritty `Selection`); render highlight.
- [ ] Copy selection → clipboard (⌘C) via `term.selection_to_string()`.
- [ ] Mouse reporting passthrough (send mouse events to TUIs that request `MOUSE_MODE`/`SGR_MOUSE`).
- [ ] IME / dead keys / composition input.
- [ ] **VERIFY:** vim, tmux, less, a mouse-driven TUI usable; copy/paste works; IME composes. ✅
- [ ] Commit: `feat(gpui-3b): mouse selection + clipboard copy`.

## Phase 4 — Workspace shell (tabs, splits, zoom)

- [x] Port `pane-tree` model to Rust → `app/src/pane_tree.rs`: `Pane` enum
      (Terminal / Explorer / Split), `PaneTree { panes: HashMap, root, next_id }` (the tree owns
      id allocation, unlike the TS version which took ids from the caller).
- [x] Port tree ops: `split`, `close` (collapse parent → sibling, rewire grandparent, return
      focus leaf), `find_parent`, `first_leaf`, `leaf_ids`/`terminal_ids`/`explorer_ids` (DFS,
      a-before-b), `adjacent` (linear Nav), `set_ratio` (clamp [0.1, 0.9]). Ported from
      `src/pane-tree.ts`.
- [x] Unit tests mirroring the TS behavior — 11 tests (new/split/split-copies-cwd/nested-parent-
      rewire/close-collapse/close-nested-grandparent/close-root-noop/adjacent/ratio-clamp/
      split-non-leaf-errors/type-filters), all pass. (Built ahead of UI wiring, which is blocked
      on the text-rendering fix.)
- [x] Workspace state → `app/src/workspace.rs`: `Workspace { name, active_tab, next_tab_id,
      tabs }` + `Tab { id, title, active_pane, zoomed, tree }` (moved here from `db.rs` — it's
      the same struct the DB persists, no separate snapshot type). Ops ported from
      `store.ts`: add/close/select/cycle tab, split_active, close_active_pane (only-pane →
      close tab; last tab → fresh one), activate_pane, navigate (zoom-aware), toggle_zoom,
      set_ratio, flip_active (terminal↔explorer), handle_shell_exit. 10 tests. (UI side effects —
      focus, font-zoom — are the renderer's job, excluded.)
- [~] Terminal session cache keyed by pane id — the state model is UI-free; the live session
      cache keys on **(tab id, pane id)** (pane ids are per-tree, not globally unique) and lands
      with the UI wiring.
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

## Phase 5 — Persistence (SQLite) — DB layer DONE (headless)

DB layer built + unit-tested in `app/src/db.rs` while Xcode downloaded. The app-side wiring
(autosave/load/quit hooks) is deferred to when the Phase 4 workspace UI exists (needs rendering).

- [x] App-data dir `~/Library/Application Support/com.tbias.app` (`default_db_path`, creates dir).
- [x] `db` module: `rusqlite` bundled (SQLite compiled from source via CLT's C toolchain);
      `open(path)` / `open_in_memory()` + `migrate`.
- [x] Migrations: `workspaces`, `tabs`, `panes`, `shells`. Pane tree stored via split `a`/`b`
      pointers; `panes` PK is `(workspace_id, tab_id, id)` so each tab's tree owns its id space.
- [x] Serialize: `save_workspace` (one transaction, wholesale tabs/panes rewrite) — recomputes
      each pane's `parent_id` from the tree shape (root → NULL).
- [x] Deserialize: `load_workspace` — rebuilds each `PaneTree` via `from_parts`; root = the pane
      with no parent (falls back to the tab's active pane).
- [ ] Save: debounced autosave on layout change + save on quit — **deferred** (needs workspace UI).
- [ ] Load/hydrate on startup; fall back to a fresh single-tab workspace — **deferred** (UI).
- [x] Shell records: `insert_shell` (pane/pid/command/cwd, status 'running'), `mark_shell_exited`
      (status/exit ts), `list_shells`. (Wiring into `Terminal` spawn/exit is a small follow-up.)
- [x] Track shell cwd: `Terminal::cwd()` via macOS `proc_pidinfo(PROC_PIDVNODEPATHINFO)` on the
      shell pid (captured at spawn). OSC 7 isn't an option — alacritty_terminal/vte don't parse
      it. Used by the explorer to follow `cd`; also available for future titles/restore. (libc
      dep added; `vip_path` is `[[c_char;32];32]`.)
- [~] **VERIFY:** headless round-trip tests (5) pass: empty→None, full workspace round-trips
      byte-for-byte (tabs, split with ratio 0.75, cwd, zoom, active pane, next-id allocators),
      idempotent replace (shrinking workspace drops old rows), split tree shape survives, shell
      insert→exit. The real "quit → relaunch → layout restored" check happens once the UI wires
      in (post-render-fix).
- [x] Commit: `feat(gpui-5): SQLite persistence layer` (DB + tests; UI wiring later).

## Phase 6 — File explorer + flip explorer

- [x] `fs` module → `app/src/fs.rs`: `Sandbox` with a lexical, **clamping** path guard (`..`
      can never traverse out of the root — the security-critical part), `list_dir` (dirs-first,
      case-insensitive), `read_text`, symlink-aware entry kinds. Ported from `fs/sandbox.ts`.
      4 tests incl. traversal-cannot-read-outside-root. (UI below is blocked on the render fix.)
- [x] Explorer pane UI → `app/src/explorer.rs` (state) + `Root::render_explorer` in `main.rs`:
      header (repo path + `..` up button) + scrollable entry list. Read-only, rooted at the repo
      (cwd), all access via the `fs::Sandbox` guard. Plain GPUI div tree (not a canvas).
- [x] Type styling: `ls -F`-style — dirs blue with `/`, symlinks cyan with `@`, files default.
      (Emoji icons skipped — uncertain color-font support; text markers are crisp + safe.)
- [x] Navigate into dirs (click), up-navigation (`..`). Keyboard nav = future.
- [x] **Follows the repo the terminal is in:** on flip-to-explorer, `Explorer::follow(cwd)`
      re-roots at the git repo containing the shell's cwd (nearest `.git`, else the cwd itself)
      and opens at the current subdir — so `cd` around, flip, and you land where the shell is;
      `..` browses up to the repo root but no further. `repo_location` unit-tested.
- [x] Flip explorer: **⌘E** (and a `⇋` toolbar button) flips the pane terminal ↔ explorer with a
      horizontal card-flip squish (`with`-timer animation, face swaps at t=0.5, terminal frozen
      from PTY-resize mid-flip via a `frozen` flag on `terminal_element`).
- [ ] Open file behavior: `.md` → Phase 7 preview; others → ignore. (Files are no-op for now.)
- [x] **VERIFY:** ✅ on-screen — flip animates, explorer shows the repo, folder/`..` navigation
      works, flips back to a live terminal. (First feature verified visually post-Blade-fix.)
- [x] Commit: `feat(gpui-6): file explorer + flip`.

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
