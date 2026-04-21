# Terminal Emulator Replacement Plan

## Problem

The custom canvas-based terminal renderer (TerminalHost, TerminalCore, Screen, Parser, VirtualCanvas, Renderer, GlyphAtlas) has required extensive work on scroll, dirty tracking, glyph rendering, and VT compatibility. Despite progress, rendering quality for TUI apps and smooth scrolling remain problematic. The rest of the app (canvas diagramming, file explorer, editor, prompt stacker) works well and should stay as-is.

## Goal

Replace the custom terminal emulator with a proven open-source library while preserving:
- The Rust PTY backend (pty.rs — spawn, write, resize, close)
- All IPC commands and event wiring
- Tab/pane system, session persistence, shell registry
- FlipExplorer, PromptStacker, Canvas, Editor
- OSC 7 CWD tracking (drives file explorer)
- OSC 133 prompt navigation (Cmd+Up/Down)
- Search in scrollback (Cmd+F)
- The hostCache pattern for pane remounting during splits

---

## Options Evaluated

### 1. xterm.js — RECOMMENDED

**What it is:** The standard web terminal emulator. Used by VS Code, Hyper, GitHub Codespaces, Gitpod, Eclipse Theia, Railway, Render, and hundreds of other products.

**Why it fits:**
- Runs in a WebView (our Tauri frontend) — drop-in compatible
- Full VT100/VT220/xterm escape sequence support, battle-tested at massive scale
- Handles rendering, scrollback, selection, clipboard, IME, accessibility out of the box
- Addon ecosystem: search, weblinks, fit, canvas renderer, WebGL renderer, image protocol, Unicode 11
- Active maintenance (200+ contributors, weekly releases)
- MIT licensed

**Rendering options:**
- DOM renderer (default) — reliable, accessible, works everywhere
- Canvas renderer addon — faster, closer to our current approach
- WebGL renderer addon — fastest, GPU-accelerated, best for high throughput

**What we get for free (things we built manually):**
- VT parsing + screen buffer management
- Scrollback with proper dirty tracking
- Selection + clipboard (Cmd+C/V works natively)
- IME composition
- Search (via @xterm/addon-search)
- Hyperlinks (via @xterm/addon-web-links)
- Auto-fit to container (via @xterm/addon-fit)
- Mouse tracking (all modes)
- Bracketed paste
- Focus events
- Synchronized output (DEC 2026)
- Unicode/emoji/CJK handling (via @xterm/addon-unicode11)
- Image protocols (via @xterm/addon-image) — Sixel, iTerm2 inline images
- Accessibility / screen reader support

**What we'd need to wire up ourselves:**
- OSC 7 CWD tracking — xterm.js has `parser.registerOscHandler(7, ...)` API
- OSC 133 prompt marks — xterm.js has `registerMarker()` + decoration API
- The detach/reattach pattern — xterm.js has `terminal.open(container)` which can be called on a new element
- Theme mapping — convert our TOML theme config to xterm.js ITheme format

### 2. Alacritty — NOT VIABLE

Alacritty is a standalone terminal application, not an embeddable library. The `vte` crate (which we already use) comes from the Alacritty project, but Alacritty itself cannot be embedded in a Tauri WebView. Not an option.

### 3. alacritty_terminal crate — MARGINAL IMPROVEMENT

This Rust crate provides terminal emulation logic (parsing, screen buffer) without rendering. We could use it instead of our custom screen.rs. However, this is essentially what we're already doing with `vte` + `screen.rs` — it would improve VT compatibility but wouldn't solve the rendering problem. We'd still need a frontend renderer. Not worth the migration cost alone.

### 4. WezTerm — NOT VIABLE

WezTerm is another standalone terminal application. Not embeddable.

---

## Recommended: xterm.js Integration

### Architecture Change

```
BEFORE:
  PTY (Rust) → pty-output event → TerminalHost.write() → Parser → Screen → VirtualCanvas → CanvasRenderer
  PTY (Rust) → frame-ready event → TerminalHost.drawFrame() → CanvasRenderer.drawFrame()

AFTER:
  PTY (Rust) → pty-output event → xterm.Terminal.write()
  xterm.js handles everything: parsing, screen, scrollback, rendering
```

### What Gets Deleted (~4,500 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `src/terminal/TerminalHost.ts` | ~1,800 | DOM orchestrator, events, overlays |
| `src/terminal/TerminalCore.ts` | ~450 | Pure terminal state machine |
| `src/terminal/Screen.ts` | ~1,800 | VT parser handler, modes, cursor |
| `src/terminal/Parser.ts` | ~400 | Paul Williams VT state machine |
| `src/terminal/VirtualCanvas.ts` | ~1,000 | Typed-array cell buffer |
| `src/terminal/Renderer.ts` | ~550 | Canvas2D glyph atlas renderer |
| `src/terminal/GlyphAtlas.ts` | ~300 | Dynamic texture atlas |
| `src/terminal/ScrollPageCache.ts` | ~150 | Scrollback page cache |
| `src/terminal/Selection.ts` | ~100 | Text selection |
| `src/terminal/input.ts` | ~200 | Keyboard → escape sequence |
| `src/terminal/types.ts` | ~50 | Cell types |

### What Gets Deleted on the Rust Side

| File | Lines | Purpose |
|------|-------|---------|
| `src-tauri/src/screen.rs` | ~1,000 | Rust VT parser + screen buffer |

The Rust VT backend becomes unnecessary — xterm.js handles all VT parsing. The PTY reader thread in pty.rs would simplify to just emitting raw bytes (no `screen.process()` call, no `frame-ready` events, no `get_frame` command).

### What Gets Created

**`src/terminal/XtermHost.ts`** (~200-300 lines) — Thin wrapper around xterm.js Terminal:

```typescript
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

export class XtermHost {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  
  // Same public API as TerminalHost:
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;
  onCwdChange?: (cwd: string) => void;

  constructor(container: HTMLElement, options: TerminalOptions) {
    this.terminal = new Terminal({
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      theme: mapTheme(options.theme),
      scrollback: options.scrollbackLimit,
      cursorStyle: options.cursorStyle,
      cursorBlink: options.cursorBlink,
    });
    
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    
    this.terminal.open(container);
    
    // Try WebGL, fall back to canvas
    try { this.terminal.loadAddon(new WebglAddon()); } catch {}
    
    this.terminal.onData((data) => this.onData?.(data));
    this.terminal.onResize(({ cols, rows }) => this.onResize?.(cols, rows));
    this.terminal.onTitleChange((title) => this.onTitleChange?.(title));
    
    // OSC 7 CWD tracking
    this.terminal.parser.registerOscHandler(7, (data) => {
      // data is "file://hostname/path"
      try {
        const url = new URL(data);
        this.onCwdChange?.(decodeURIComponent(url.pathname));
      } catch {}
      return true;
    });
    
    this.fitAddon.fit();
  }

  write(data: string) { this.terminal.write(data); }
  fit() { this.fitAddon.fit(); }
  focus() { this.terminal.focus(); }
  
  dispose() { this.terminal.dispose(); }
  
  // For pane remounting:
  detach() { /* xterm.js doesn't natively support this — see notes below */ }
  reattach(container: HTMLElement) { /* see notes below */ }
  
  // Search
  search(query: string) { this.searchAddon.findNext(query); }
  searchPrev() { this.searchAddon.findPrevious(); }
  clearSearch() { this.searchAddon.clearDecorations(); }
  
  get gridSize() { return { cols: this.terminal.cols, rows: this.terminal.rows }; }
}
```

### What Gets Modified

**`src/Terminal.tsx`** — Simplified significantly:
- Create XtermHost instead of TerminalHost
- Feed `pty-output` directly to `host.write(data)` (no Rust frame path)
- Remove `frame-ready` listener entirely
- Remove `GET_FRAME_CMD`, `SCROLL_VIEWPORT_CMD`, `RESET_VIEWPORT_CMD` calls
- Keep: spawn_shell, write_to_pty, resize_pty, close_pane, shell records, CWD/title callbacks

**`src-tauri/src/pty.rs`** — Simplified:
- Reader thread just emits raw bytes via `pty-output-{paneId}` (already does this)
- Remove `screen.process()` calls
- Remove `frame-ready` emission
- Remove `get_frame`, `scroll_viewport`, `reset_viewport` commands

**`src-tauri/src/lib.rs`** — Remove screen-related IPC handlers

**`src/Panes.tsx`** — Minor: TerminalView now renders a `<div>` container instead of `<canvas>`

### Open Questions

**1. Detach/Reattach for pane remounting:**
xterm.js doesn't natively support moving a Terminal to a new container. Options:
- a) Recreate the Terminal on remount and replay the screen buffer (xterm.js has `terminal.buffer` API to read state, but no built-in serialize/deserialize)
- b) Keep the container DOM element alive across remounts (hide/show instead of destroy/recreate)
- c) Use xterm.js's `terminal.element` and reparent it to the new container

Option (c) is simplest — just move the existing DOM node: `newContainer.appendChild(terminal.element)`.

**2. OSC 133 prompt marks:**
xterm.js has a marker/decoration API (`terminal.registerMarker()`) that can be used to track prompt positions. The `@xterm/addon-shell-integration` may handle this, or we register custom OSC handlers.

**3. Search UI:**
Our current search bar (Cmd+F) wires into TerminalCore.search(). With xterm.js, we'd wire into `searchAddon.findNext(query, { regex, caseSensitive })`. Same UI, different backend.

**4. Theme mapping:**
Our TOML config has 16 ANSI colors + background/foreground/cursor/selectionBg. xterm.js ITheme has the same fields with slightly different names. Straightforward mapping.

**5. Performance comparison:**
- Our CanvasRenderer: ~2ms per full frame, glyph atlas caching
- xterm.js DOM renderer: slower, but more compatible
- xterm.js Canvas addon: comparable to our renderer
- xterm.js WebGL addon: faster than our renderer, GPU-accelerated
- Recommendation: use WebGL addon with canvas fallback

---

## Migration Plan

### Branch: `feature/xterm-migration`

**Phase 1: Install + Scaffold**
1. `bun add @xterm/xterm @xterm/addon-fit @xterm/addon-search @xterm/addon-web-links @xterm/addon-webgl`
2. Add `@xterm/xterm/css/xterm.css` import
3. Create `src/terminal/XtermHost.ts`
4. Create new `src/Terminal.tsx` that uses XtermHost

**Phase 2: Wire Up**
5. Update Panes.tsx — terminal pane renders a `<div>` container instead of `<canvas>`
6. Wire PTY events: `pty-output` → `host.write()`, `pty-exit` → cleanup
7. Wire callbacks: onData → write_to_pty, onResize → resize_pty, onTitleChange, onCwdChange
8. Implement OSC 7 handler for CWD tracking
9. Wire search bar to searchAddon

**Phase 3: Simplify Rust Backend**
10. Remove `screen.process()` from pty.rs reader thread
11. Remove `frame-ready` event emission
12. Remove `get_frame`, `scroll_viewport`, `reset_viewport` commands from lib.rs
13. Keep screen.rs file but unused (delete in Phase 4)

**Phase 4: Clean Up**
14. Delete old terminal files: TerminalHost, TerminalCore, Screen, Parser, VirtualCanvas, Renderer, GlyphAtlas, ScrollPageCache, Selection, input.ts, types.ts
15. Delete screen.rs
16. Delete terminal test files that test the old parser/screen
17. Update tests if needed
18. Update daily summary

**Phase 5: Polish**
19. Test all TUI apps: vim, htop, tmux, less, Claude Code, Gemini
20. Test FlipExplorer CWD sync
21. Test search
22. Test paste / Wispr Flow
23. Test session restore
24. Test pane splits and remounting
25. Performance benchmark vs old renderer

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| xterm.js scroll is chunky | Low | Medium | WebGL addon handles smooth scroll natively |
| Detach/reattach breaks | Medium | High | Use DOM reparenting (option c) |
| OSC 133 prompts lost | Low | Medium | xterm.js marker API + custom OSC handler |
| Bundle size increase | Low | Low | xterm.js is ~400KB, replaces ~4,500 lines of custom code |
| Theme mismatch | Low | Low | Simple property mapping |
| IME regression | Low | Medium | xterm.js handles IME natively, well-tested |

## Decision

**Recommend xterm.js with WebGL renderer addon.** It eliminates the entire custom rendering stack (~4,500 lines of JS + ~1,000 lines of Rust), replaces it with the most battle-tested terminal emulator in the web ecosystem, and gives us features we haven't built (image protocols, accessibility, WebGL rendering) for free. The migration is contained to the terminal layer — the rest of the app (canvas, editor, file explorer, prompt stacker, session system) is untouched.

Work on a `feature/xterm-migration` branch so the current codebase stays intact on `main`.
