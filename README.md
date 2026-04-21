# t-bias

A terminal emulator for people who live in the command line. t-bias gives you a fast, native shell with tabs, split panes, and built-in tools — a file explorer that flips out from any terminal pane, a prompt stacker for saving and queuing reusable commands, and a code editor. Your workspace layout persists across sessions so you pick up right where you left off.

Built with Tauri and Rust on the backend, SolidJS on the frontend, and a fully custom terminal renderer — no xterm.js. The VT parser, screen model, glyph atlas, and canvas rendering pipeline are all built from scratch.

## Features

**Terminal**
- Real PTY-backed shell with full VT500 escape sequence support
- Canvas rendering with a glyph atlas (dirty-row tracking, sub-row invalidation)
- Truecolor, 256-color, alternate screen, mouse tracking (SGR), bracketed paste
- Grapheme cluster segmentation (emoji, CJK, combining characters) via Intl.Segmenter
- Reflow on resize — soft-wrapped lines merge/split correctly
- Scrollback with search (Cmd+F, regex, case toggle)
- OSC 8 hyperlinks + auto-detected URL hover/click
- OSC 52 clipboard read/write
- OSC 133 shell integration (Cmd+Up/Down prompt jumping, exit status indicators)
- OSC 7 working directory tracking

**Workspace**
- Tabs (Cmd+T, Cmd+W, Cmd+1-9, Cmd+Shift+[/])
- Split panes (Cmd+D horizontal, Cmd+Shift+D vertical, Cmd+Option+Arrow nav)
- Zoom pane (Cmd+Shift+Enter)
- Session persistence — full workspace layout auto-saves on quit and restores on launch
- Named sessions via shell registry
- Close confirmation when processes are running
- Foreground process detection for tab titles

**Tools**
- Flip Explorer — terminal panes flip to reveal a file explorer (Cmd+/)
- Built-in code editor with canvas renderer and regex tokenizer
- Markdown preview (Blog MD) for .md files
- Prompt Stacker — save, edit, delete, duplicate, search, and queue reusable prompts
- Prompt Queue footer bar — copy or send prompts directly to the active shell (Cmd+Shift+Q to advance)

**Configuration**
- TOML config at `~/.config/tbias/config.toml`
- Font, theme (16 ANSI colors), cursor style, scrollback limit, shell, padding
- Built-in theme presets: Dracula, Solarized Dark, One Dark, Catppuccin Mocha
- See [config.example.toml](config.example.toml) for all options

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close pane/tab |
| Cmd+D | Split horizontal |
| Cmd+Shift+D | Split vertical |
| Cmd+Option+Arrow | Navigate panes |
| Cmd+Shift+Enter | Toggle zoom |
| Cmd+1-9 | Switch to tab |
| Cmd+Shift+[/] | Cycle tabs |
| Cmd+/ | Flip explorer |
| Cmd+F | Search in scrollback |
| Cmd+Up/Down | Jump between prompts |
| Cmd+Shift+Q | Advance prompt queue |
| Cmd+C | Copy selection |
| Cmd+V | Paste |
| Cmd++/- | Zoom in/out |
| Cmd+0 | Reset zoom |

## Known Limitations

- macOS only (Windows/Linux builds not yet verified)
- No image protocol support (Kitty, Sixel, iTerm2)
- No font fallback chain (missing glyphs render as blank)
- No ligature support
- Scrollback reflow not yet implemented (only active screen reflows)
- IME composition works but has not been tested with CJK input methods
- No screen reader / accessibility support

## Development

```bash
bun install
bun run test        # 115 frontend + 8 Rust tests
bun run build
cargo tauri dev
```

Backend-only check:

```bash
cd src-tauri
cargo check
cargo test
```
