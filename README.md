# t-bias

t-bias is a native desktop terminal emulator built with Tauri, Rust, SolidJS, and a custom canvas renderer. It runs a real shell, uses a custom VT parser and screen model, and does not depend on `xterm.js` or other terminal emulation libraries.

## What It Does

- Runs a real PTY-backed shell
- Renders terminal output to canvas with a custom glyph atlas
- Supports tabs and split panes
- Persists sessions and named workspaces
- Tracks the terminal working directory for new tabs and explorer views
- Detects foreground CLI tools and uses them for tab titles when appropriate
- Supports scrollback, selection, copy, paste, zoom, and resize
- Supports truecolor, alternate screen, mouse tracking, bracketed paste, and OSC 8 hyperlinks
- Includes a flip-side file explorer for terminal panes
- Opens files in a built-in editor tab
- Renders markdown files in a styled `Blog MD` preview
- Includes Prompt Stacker for saving reusable prompts

## Configuration

t-bias reads its config from the platform config directory.

Example on macOS:

```text
~/Library/Application Support/tbias/config.toml
```

See [config.example.toml](config.example.toml) for available options.

## Development

```bash
bun install
bun run test
bun run build
cargo tauri dev
```

For a backend-only verification pass:

```bash
cd src-tauri
cargo check
```
