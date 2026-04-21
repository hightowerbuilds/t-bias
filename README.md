# t-bias

A terminal emulator built for developers who live in the command line.

## What it does

- **Terminal** — Real PTY shell with Rust-native VT processing, canvas rendering, truecolor, mouse tracking, scrollback search, and synchronized output for clean TUI rendering
- **Tabs & Splits** — Multiple tabs, horizontal/vertical split panes, zoom, and full workspace persistence across sessions
- **Flip Explorer** — Any terminal pane flips to reveal a file explorer (Cmd+/)
- **Prompt Stacker** — Save, search, and queue reusable prompts and commands
- **Code Editor** — Built-in editor with syntax highlighting
- **Infinite Canvas** — Diagramming tool for sketching project plans with rectangles, connecting lines, and text. Save and manage multiple canvases

## Stack

Tauri + Rust backend, SolidJS frontend, Canvas2D rendering with glyph atlas. VT parsing via the `vte` crate (same parser as Alacritty). No xterm.js, no DOM terminal.

## Development

```bash
bun install
bun run test
cargo tauri dev
```

## Status

macOS only. Active development.
