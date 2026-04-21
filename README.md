# t-bias

A terminal emulator built for developers who live in the command line.

## What it does

- **Terminal** — Real PTY shell powered by xterm.js with WebGL rendering, full VT compatibility, smooth scrollback, truecolor, mouse tracking, and native clipboard support
- **Tabs & Splits** — Multiple tabs, horizontal/vertical split panes, zoom, and full workspace persistence across sessions
- **Flip Explorer** — Any terminal pane flips to reveal a file explorer (Cmd+/)
- **Prompt Stacker** — Save, search, and queue reusable prompts and commands
- **Code Editor** — Built-in editor with syntax highlighting
- **Infinite Canvas** — Diagramming tool for sketching project plans with rectangles, connecting lines, and text. Save and manage multiple canvases

## Stack

Tauri + Rust PTY backend, SolidJS frontend, xterm.js terminal rendering (WebGL with canvas fallback). Canvas2D for the code editor and diagramming tools.

## Development

```bash
bun install
bun run test
cargo tauri dev
```

## Status

macOS only. Active development.
