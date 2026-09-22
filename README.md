# t-bias

A native macOS terminal built with Rust, GPUI Kit’s Metal renderer, Alacritty's terminal engine, and portable-pty.

## Run

Install the Rust toolchain through rustup and Apple's Command Line Tools, then:

```sh
./dev          # build and launch; replaces a previous development instance
./dev build    # compile only
./dev release  # optimized build and launch
```

Rust 1.95.0 is pinned in `app/rust-toolchain.toml`. The app pins GPUI Kit 0.6.6 and one GPUI pre 0.3.6 family, using Metal with runtime shaders. It requires macOS 15 or newer and does not require the full Xcode Metal compiler. The migration has been exercised on the Intel/AMD development Mac. The app uses system fonts and has no webview or JavaScript runtime.

## Workspace

Tabs contain binary split trees. Shell sessions survive tab switches, zoom, and explorer flips. Layout, working directories, active panes, and shell records live in SQLite; reopening restores the layout with fresh login shells, not previous process memory or scrollback.

| Shortcut | Action |
| --- | --- |
| ⌘T / ⌘W | New tab / close active pane |
| ⌘D / ⌘⇧D | Split side by side / above and below |
| ⌘Enter | Zoom active pane |
| ⌘[ / ⌘] / ⌘1–9 | Previous / next / numbered tab |
| ⌘Option + arrow | Navigate panes |
| ⌘E | Flip terminal ↔ files |
| ⌘C / ⌘V | Copy selection / paste |
| ⌘+ / ⌘− / ⌘0 | Font size up / down / reset |
| ⌘⇧P | Prompt library |
| ⌘⇧Q | Send next queued prompt |
| ⌘, | Open settings |
| ⌘⇧A | Open / close Activity Monitor |

Drag a divider to resize a split; drag a tab onto another tab to reorder it. Double-click selects a word, triple-click selects a line, and Option-drag selects a block. Hold Shift to select locally when a TUI captures the mouse. IME composition is staged locally until committed.

The explorer follows the shell's current directory and is confined to its Git repository (or the directory itself outside Git). Use arrows and Enter to browse, Backspace to go up, Escape to return. Markdown previews support font controls and Default, Newspaper, Invoice, and Diagram styles; `S` cycles styles while browsing a preview.

The prompt library supports multiline editing, tags, search, duplication, deletion, ordered queues, and JSON import/export compatible with the previous app. **Send inserts text into the active terminal without pressing Enter.** The queue advances when sending its next item.

## Navigation

The persistent footer opens **Terminal**, **Files**, **Prompts**, **Activity**, **Learn**, **Computer**, and **Controller**. Use **⌘⌥1–7** in the same order. Files shows the active pane's explorer; Prompts opens the existing library beside the workspace. Switching surfaces preserves running shells and monitor state. The active footer item follows in-surface navigation too.

**Controller** opens a live PS2-style diagram rendered with wgpu on Metal. Select a connected device, watch buttons and sticks, then click a control or use arrows/Tab to select it. Choose Terminal, Files, Learn, or Computer and assign a button action. **Press a control to select** captures a physical button; **Test draft mappings** previews action names without executing them. **Apply** saves and activates the draft; **Discard** restores saved assignments, and **Reset this surface** restores defaults in the draft. Unsaved edits survive navigation. Use Enter or brackets to cycle actions, 1–4 to change surface, and ⌘S to apply.

The diagram remains editable without hardware. Stick bindings remain fixed, trigger travel is unavailable, and the PS2 illustration describes logical controls rather than identifying your hardware. DS2 adapter and DS4 transport validation remain in the [controller roadmap](daily-growth/roadmaps/controller-surface-roadmap.md).

## Activity Monitor

Choose **View → Activity Monitor**, click **Activity**, or press **⌘⇧A**. The native monitor shows local processes, CPU usage, resident memory, ownership, thread count, and process state. Search by name/PID, click headers to sort, and select a row for details. **This Workspace** and **Active Pane** follow shell descendants; **Show in Terminal** returns to their session when the association is known. Detached jobs, shared tmux servers, and remote workloads may not map to one pane.

**⌘F** focuses search; Enter moves into results; arrows select; **⌘C** copies a row. **⌘W** closes the monitor and preserves running shells. Escape clears search, then selection, then closes. Sampling pauses while inactive or closed; Pause freezes samples, and the interval button cycles 1/2/5 seconds. CPU needs two samples after starting or resuming. A process can exceed 100% CPU by using multiple logical cores. Resident memory (RSS) includes shared pages; the memory graph shows wired RAM, not Apple's memory-pressure metric. Unavailable data appears as an em dash.

The Kit process table virtualizes rows and supports dragging column boundaries to resize them. Column widths stay in memory for the current monitor session; existing saved preferences keep their previous format. Selection follows PID plus process-start identity through sorting and refresh. Choose **Tree** to expand process families and inspect separate direct and subtree totals. Summed RSS can include shared pages; unavailable members are counted explicitly. Scope, sort, column visibility, and list/tree mode are saved separately from terminal workspace data. Searches, selected PIDs, process snapshots, and expansion state are temporary.

**Learn** opens the first three lessons of [Inside Your Computer](docs/learning/README.md): processes, CPU and time, and memory. The **?** links beside process, CPU, and memory headers open the matching lesson. Returning keeps your table state.

**Computer** opens a native 3D educational model with CPU, RAM, storage, and network stations. CPU and RAM annotations use monitor samples; storage and network remain conceptual. Fly with the left stick, look with the right stick, descend/ascend with L1/R1, reset with Triangle, and return with Circle. D-pad left/right jumps between stations; Cross opens a CPU or RAM lesson. Keyboard controls are WASD, arrows, Q/E, R, and Escape. Station buttons and a **2D / no motion** option provide an alternative to flight. This is a teaching model, not a guest operating system or a reconstruction of your motherboard. Physical-controller flight verification remains pending.

The monitor remains read-only. Process termination, advanced metrics, richer detail history, and broader release validation remain in the [Activity Monitor roadmap](daily-growth/roadmaps/activity-monitor-roadmap.md). It uses bounded in-memory history and stores no process history in SQLite. Configure its startup interval with `[activity_monitor]` and `refresh_seconds = 2` in `config.toml` (valid values: 1, 2, 5; restart to apply).

## Configuration and data

Choose **Settings** or press **⌘,** to edit appearance, terminal font/layout, cursor blink, Option-as-Meta, monitor refresh, and shortcuts. **Apply** validates and saves; restart the app to activate those settings. **Discard** restores the editor’s saved baseline, **Reload saved** reads external edits, and **Open configuration** opens the TOML file. Drafts survive navigation. Saving preserves controller profiles, untouched settings/comments, and the original file on errors or detected conflicts.

Default directory: `~/Library/Application Support/com.tbias.app/`

- `config.toml`: created on first launch; font, line height, padding, opacity, cursor blink, theme, action shortcuts, and versioned `[controller]` button overrides. Themes: `dark`, `light`, `dracula`. Controller Apply activates immediately; use **Reload saved** for external controller edits. Restart for other settings. `option_as_meta = false` lets macOS compose Option-key accents; set it to `true` for terminal Meta sequences.
- `tbias.db`: workspace, shell records, and prompt library.
- `startup.log`: startup and error diagnostics, rotated after 5 MB.
- `TBIAS_DATA_DIR`: override the data directory, useful for isolated tests.
- `TBIAS_CONFIG`: override the configuration file path.

Invalid configuration is reported in the window and defaults are used for that launch. The invalid file is preserved.

## Verify and package

```sh
./scripts/check-native.sh        # formatting, tests, build
./scripts/check-native.sh --gui  # also exercise real shells and native workspace flows
./scripts/check-native.sh --activity # CPU/RSS probe, pause/resume, monitor GUI smoke
./scripts/check-native.sh --controller # Metal rendering, capture isolation, saved remap dispatch
./scripts/check-native.sh --kit # Kit prompts/settings, PTY isolation, 10,000-row table
./scripts/package-native.sh      # optimized macOS .app and ZIP in dist-native/
```

The GUI smoke test creates an isolated temporary database. It checks real shell input, selection/copy, splits, zoom, tabs, session survival, layout persistence, prompt panel rendering, explorer flips, pane closing, Vim, less, tmux, and Markdown rendering. Install tmux to run the complete TUI smoke check. It needs a logged-in macOS desktop.

Packaging uses an ad-hoc signature by default for local use. For distribution, provide a Developer ID identity through `TBIAS_SIGN_IDENTITY` and an existing `notarytool` keychain profile through `TBIAS_NOTARY_PROFILE`; the packaging script signs with hardened runtime, submits for notarization, staples, and recreates the ZIP. Credentials are never stored in this repository. Builds target the current Mac's architecture. Updates are manual replacement of the app bundle; signed automatic updates are deferred.

## Code map

The main application now uses GPUI Kit for prompts, shared controls, settings, and Activity Monitor’s virtualized DataTable. The [integration roadmap](daily-growth/roadmaps/gpui-kit-integration-roadmap.md) records delivery and remaining hardware/input/performance validation. The [compatibility lab](experiments/gpui-kit/README.md) remains a separate diagnostic tool; use `./dev` to run the actual app.

- `app/src/main.rs`, `menus.rs`: window startup and native menus.
- `workspace_view.rs`: tab/split UI, pane session cache, autosave, restore.
- `workspace.rs`, `pane_tree.rs`, `db.rs`: layout model and SQLite persistence.
- `terminal.rs`, `terminal_view.rs`, `terminal_pane.rs`: PTY lifecycle, emulator rendering, input and explorer face.
- `input.rs`, `mouse.rs`: keyboard and mouse protocol encoding.
- `explorer.rs`, `fs.rs`, `markdown.rs`: directory navigation and Markdown.
- `prompts.rs`, `prompt_panel.rs`: prompt storage and Kit editor.
- `ui.rs`, `settings.rs`: shared controls/theme roles and settings drafts.
- `config.rs`: configuration and logging.
- `gamepad.rs`, `gamepad/hub.rs`: logical controls, one device polling thread, per-device state and bounded input delivery.
- `controller.rs`, `controller/`: visual map/editor, typed button profiles, atomic configuration saves, wgpu renderer and WGSL illustration.
- `activity/`: macOS process collection, bounded background sampling, process scopes, Kit virtualized table, stable selection adapter, and native graphs.

The [native roadmap](daily-growth/roadmaps/gpui-rebuild-roadmap.md) records delivery and verification. The [controller roadmap](daily-growth/roadmaps/ps2-terminal-roadmap.md) is separate. The [Activity Monitor roadmap](daily-growth/roadmaps/activity-monitor-roadmap.md) tracks the process monitor and its remaining work. Infinite canvas, Linux, and Windows remain optional follow-up work.
