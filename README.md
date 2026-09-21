# t-bias

A native macOS terminal built with Rust, GPUI's Blade renderer, Alacritty's terminal engine, and portable-pty.

## Run

Install the Rust toolchain through rustup and Apple's Command Line Tools, then:

```sh
./dev          # build and launch; replaces a previous development instance
./dev build    # compile only
./dev release  # optimized build and launch
```

Rust 1.95.0 is pinned in `app/rust-toolchain.toml`. GPUI is pinned to crates.io 0.2.2 with `macos-blade`: this renderer works on the Intel/AMD development Mac without the Metal shader compiler from Xcode. The app uses system fonts and has no webview or JavaScript runtime.

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
| ⌘, | Open configuration |

Drag a divider to resize a split; drag a tab onto another tab to reorder it. Double-click selects a word, triple-click selects a line, and Option-drag selects a block. Hold Shift to select locally when a TUI captures the mouse. IME composition is staged locally until committed.

The explorer follows the shell's current directory and is confined to its Git repository (or the directory itself outside Git). Use arrows and Enter to browse, Backspace to go up, Escape to return. Markdown previews support font controls and Default, Newspaper, Invoice, and Diagram styles; `S` cycles styles while browsing a preview.

The prompt library supports multiline editing, tags, search, duplication, deletion, ordered queues, and JSON import/export compatible with the previous app. **Send inserts text into the active terminal without pressing Enter.** The queue advances when sending its next item.

## Configuration and data

Default directory: `~/Library/Application Support/com.tbias.app/`

- `config.toml`: created on first launch; font, line height, padding, opacity, cursor blink, theme, and action shortcuts. Themes: `dark`, `light`, `dracula`. Restart after editing. `option_as_meta = false` lets macOS compose Option-key accents; set it to `true` for terminal Meta sequences.
- `tbias.db`: workspace, shell records, and prompt library.
- `startup.log`: startup and error diagnostics, rotated after 5 MB.
- `TBIAS_DATA_DIR`: override the data directory, useful for isolated tests.
- `TBIAS_CONFIG`: override the configuration file path.

Invalid configuration is reported in the window and defaults are used for that launch. The invalid file is preserved.

## Verify and package

```sh
./scripts/check-native.sh        # formatting, tests, build
./scripts/check-native.sh --gui  # also exercise real shells and native workspace flows
./scripts/package-native.sh      # optimized macOS .app and ZIP in dist-native/
```

The GUI smoke test creates an isolated temporary database. It checks real shell input, selection/copy, splits, zoom, tabs, session survival, layout persistence, prompt panel rendering, explorer flips, pane closing, Vim, less, tmux, and Markdown rendering. Install tmux to run the complete TUI smoke check. It needs a logged-in macOS desktop.

Packaging uses an ad-hoc signature by default for local use. For distribution, provide a Developer ID identity through `TBIAS_SIGN_IDENTITY` and an existing `notarytool` keychain profile through `TBIAS_NOTARY_PROFILE`; the packaging script signs with hardened runtime, submits for notarization, staples, and recreates the ZIP. Credentials are never stored in this repository. Builds target the current Mac's architecture. Updates are manual replacement of the app bundle; signed automatic updates are deferred.

## Code map

- `app/src/main.rs`, `menus.rs`: window startup and native menus.
- `workspace_view.rs`: tab/split UI, pane session cache, autosave, restore.
- `workspace.rs`, `pane_tree.rs`, `db.rs`: layout model and SQLite persistence.
- `terminal.rs`, `terminal_view.rs`, `terminal_pane.rs`: PTY lifecycle, emulator rendering, input and explorer face.
- `input.rs`, `mouse.rs`: keyboard and mouse protocol encoding.
- `explorer.rs`, `fs.rs`, `markdown.rs`: directory navigation and Markdown.
- `prompts.rs`, `prompt_panel.rs`, `text_field.rs`: prompt storage and native editor.
- `config.rs`: configuration and logging.
- `gamepad.rs`: existing experimental controller input; controller development resumes after the native roadmap.

The [native roadmap](daily-growth/roadmaps/gpui-rebuild-roadmap.md) records delivery and verification. The [controller roadmap](daily-growth/roadmaps/ps2-terminal-roadmap.md) is separate. Infinite canvas, Linux, and Windows remain optional follow-up work.
