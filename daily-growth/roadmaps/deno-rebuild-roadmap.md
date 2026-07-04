# t-bias — Deno Rebuild Roadmap

> **Status:** Planning · Started 2026-07-03
> Living document — edit and append as we go. Newest decisions go in the Decisions Log at the bottom.

## Goal

Rebuild t-bias bottom-up, moving off Tauri/Rust-app and onto **Deno Desktop**, while keeping the one piece worth carrying forward wholesale: the Rust PTY layer. A performant, local-first terminal emulator for CLI/agent workflows (Claude Code, Vim, TUIs) with tabs, splits, workspace persistence, and the productivity surfaces (prompt stacker, flip explorer, diagram canvas).

Non-goals (for now): mobile, Windows/Linux parity (macOS-first, but keep the sidecar cross-compilable), SSR/SEO.

---

## Locked Stack

| Layer | Choice | Rationale |
|---|---|---|
| Desktop shell | **Deno Desktop** (2.9+, native WebView backend) | Single TS runtime, small binaries (~68MB), `window.bind()` in-process bindings, `deno desktop` cross-compile + `Deno.autoUpdate()` |
| Frontend | **Vite + SolidJS SPA** | Local app needs no SSR; simpler than SolidStart/TanStack Start (Nitro) |
| Routing/state | **TanStack Router + TanStack Query** | Client routing for panes; Query for async state over bindings |
| Terminal render | **xterm.js + WebGL** | Proven; carried from current app (already migrated off custom VT) |
| PTY | **Rust sidecar** (reuse `pty.rs` / `portable-pty`) | Deno has no native PTY; correctness (job control, SIGWINCH, SIGHUP teardown, cwd tracking) matters more than transport speed |
| Data | **`node:sqlite` + Drizzle ORM** | SQLite built into Deno; Drizzle `drizzle-orm/node-sqlite`. Note: drizzle-kit needs a Deno patch (`SQLITE_NODE=1` / `@hotsauce/drizzle-kit-deno-patch`) |
| Hotkeys | **tinykeys** (or `@solid-primitives/keyboard`) | Declarative chord bindings; replaces the old hand-rolled `matchKb` keybinding matcher |
| AI (optional) | **Anthropic SDK** (`@anthropic-ai/sdk`), latest Claude models (Opus 4.8 / Sonnet 5 / Haiku 4.5) | Runs in the **Deno backend** so the API key stays server-side, never in the webview. Consult the `claude-api` skill when building |

**Toolchain prerequisite:** local Deno is **2.7.11** — `deno desktop` needs **2.9+**. Run `deno upgrade` before Phase 0. (bun 1.3.10 / node 26 are fine for Vite tooling.)

**Why not pure-Deno FFI for PTY:** FFI is a mechanism, not a language choice, and the terminal's perf bottleneck is xterm.js/WebGL rendering — not PTY reads. Raw-libc FFI would reimplement all of `pty.rs`'s signal/lifecycle handling by hand in TS and risks blocking Deno's single-threaded event loop. The sidecar reuses proven code and isolates PTY work off the event loop.

---

## Runtime Architecture

```
┌─ Deno Desktop entrypoint (main.ts) ──────────────────────┐
│  • creates Deno.BrowserWindow, serves the Vite SPA        │
│  • window.bind()  → exposes backend fns to the webview    │
│  • owns SQLite (Drizzle)                                  │
│  • spawns + supervises the Rust PTY sidecar               │
└───────┬──────────────────────────────────┬───────────────┘
        │ bindings + stream channel         │ framed socket
        ▼                                    ▼
┌─ SolidJS SPA (webview) ─┐        ┌─ Rust PTY sidecar ─────┐
│  TanStack Router/Query  │        │  portable-pty          │
│  xterm.js panes         │        │  reader threads        │
│  calls bindings.*       │        │  signal/lifecycle mgmt │
└─────────────────────────┘        └────────────────────────┘
```

**Channels:**
- **Webview → Deno:** `window.bind()` call→response (spawn, write, resize, close, db queries).
- **Deno → Webview (PTY output stream):** needs a *push* channel — plan is a `Deno.serve()` WebSocket carrying the sidecar's output frames to xterm.js (mirrors today's `pty-output-{id}` events). To be validated in Phase 1.
- **Deno ↔ Sidecar:** framed protocol over a unix domain socket (spawn/write/resize/close commands ↑, output/exit frames ↓). One connection, pane-id-tagged frames.

---

## Open Questions (resolve as we hit them)

- [x] **Repo layout:** ~~in-place vs fresh repo?~~ → **Scorched in-place** (2026-07-03). Old app removed; Rust PTY + frontend port-references stashed in scratchpad seeds.
- [ ] **Hotkeys lib:** `tinykeys` (tiny, framework-agnostic) vs `@solid-primitives/keyboard` (Solid-native reactivity). Lean `tinykeys` unless we want Solid signal integration.
- [ ] **AI scope:** what does "AI integration" do? (inline command/prompt assist, terminal-output explain, agent orchestration?) → shapes whether it's a small feature or a core surface.
- [~] **Stream channel:** `Deno.serve()` WebSocket works under `deno run` (Phase 0). Still need to confirm same-origin `ws://` works *inside* the laufey webview when packaged. Fallback: `window.bind()` push.
- [ ] **Sidecar protocol:** length-prefixed JSON vs binary frames? (Output is hot path — lean binary/length-prefixed to avoid per-chunk JSON encode.)
- [ ] **Config:** keep TOML file + hot-reload watcher, or move config into SQLite? (Hot-reload was a feature; file may stay.)
- [ ] **Sidecar lifecycle:** how Deno supervises/restarts it; guaranteed teardown of PTY children on app exit (today: Rust `RunEvent::Exit` → `close_all()`).
- [ ] **Drizzle migrations in Deno:** confirm the drizzle-kit Deno patch workflow before Phase 3.

---

## Phased Plan

De-risk the unproven path (PTY ↔ Deno ↔ webview streaming) **first**.

### Phase 0 — Scaffold ✅ (spine proven headlessly; native window pending visual check)
- [x] Deno upgraded 2.7.11 → **2.9.1** (via `brew upgrade deno`; `deno upgrade` was disabled on the brew build)
- [x] `deno.json` with `desktop` block; `deno desktop` builds a native `.app` (laufey webview backend v0.5.0) embedding the SPA
- [x] Vite + SolidJS SPA (Vite 8, solid 1.9); TanStack Router (1.170) + Query (5.101) wired; typechecks clean (tsc + `deno check`)
- [x] tinykeys (4.0) wired for global hotkeys (⌘K / ⌘B demo)
- [x] **Backend bridge proven** — HTTP `/api/ping` + WebSocket `/ws` echo round-trips green (curl + deno WS client). NB: proved via `Deno.serve` HTTP+WS rather than `window.bind()`; that's the channel Phase 1 actually needs. Exact `Deno.BrowserWindow`/`window.bind()` API still TBD (guarded in main.ts).
- [x] Repo layout decided → scorched in-place
- [ ] **Visual confirm**: launch `dist-app/t-bias.app` and confirm the window renders the SPA + WS works same-origin inside the laufey webview
- [ ] Trim bundle: exclude `node_modules/` from `deno desktop` (164MB → expect ~70MB; Vite already bundles the SPA)

**Dev workflow established:** develop as a normal web app — `deno task serve` (or `PORT=4321 deno run -A --watch main.ts`) serves `dist/` + the bridge; iterate in a browser. `bun run build` rebuilds the SPA. `deno task desktop` bundles the native `.app`. main.ts degrades gracefully between browser and native (guarded BrowserWindow).

### Phase 1 — PTY spine ⭐ (the make-or-break vertical slice) — spine PROVEN
- [x] Extract `pty.rs` PTY logic into a standalone Rust sidecar crate (`sidecar/`, `tbias-pty` bin, portable-pty + libc + base64 + serde_json)
- [x] Sidecar framed protocol — **NDJSON over stdio** (not unix socket): `spawn`/`input`/`resize`/`close` ↑; `ready`/`output`/`exit`/`error` ↓, PTY bytes base64'd. Binary framing deferred as an optimization.
- [x] Deno spawns + supervises the sidecar (`pty_bridge.ts`); teardown on exit (stdin EOF → `close_all`; `unload` → SIGTERM). Reuses the SIGHUP→CONT→TERM→KILL process-group logic.
- [x] `Deno.serve()` WebSocket (`/pty?pane=N&cols&rows`) streaming PTY output → xterm.js (binary frames out, JSON `{t:"i"|"r"}` in)
- [x] **One xterm pane running a real login shell** — `XtermHost.ts` + `TerminalRoute.tsx`, bidirectional, ResizeObserver-driven resize. Verified headlessly end-to-end (input executes in zsh, output round-trips) + browser visual.
- [x] Validate real apps: `vim`, `claude`, heavy output (`yes`), and `top` batch mode (`htop` not installed) — passed via automated PTY harness
- [x] **Package the sidecar into the native `.app`** — `deno task desktop:build` copies `tbias-pty` into `Contents/MacOS`, resolves at runtime via `Deno.execPath()`, and re-signs the bundle

### Phase 2 — Panes / tabs ✅ (spine built; visual pass pending)
- [x] Ported `pane-tree.ts` (terminal + split tree, split/close/adjacent nav; editor/canvas leaf types deferred to Phase 4)
- [x] Workspace transitions rewritten leaner for the new stack (`workspace/store.ts`, createStore-based). `session-state.ts` serialization deferred to Phase 3.
- [x] Tabs, horizontal/vertical splits, zoom, pane focus + active-border
- [x] Terminal **session cache** (`terminal/session.ts`) — xterm host + `/pty` WebSocket survive split/zoom remounts (detach/reattach, not reconnect)
- [x] Global keybindings via tinykeys (⌘T/W/D, ⌘⇧D, ⌘⏎ zoom, ⌘1-9, ⌘[/], ⌘⌥arrows nav, ⌘±/0 font). Toolbar buttons duplicate splits/zoom/close since browsers swallow ⌘T/⌘W in dev.
- [ ] Visual pass: multi-tab, nested splits, divider drag, zoom, pane nav, per-pane live shells (splits, zoom, nav, tab switch, queue advance)

### Phase 3 — Persistence (Drizzle + SQLite)
- [x] Drizzle schema: workspaces, tabs, panes, shells (manual migration over `node:sqlite`; prompts / canvases deferred)
- [~] Migration workflow — manual SQL migrations working; drizzle-kit Deno patch still TBD
- [x] Restore-on-launch: workspace layout + active tab hydration
- [x] Atomic save on shutdown — debounced auto-save + `beforeunload`/`visibilitychange` `sendBeacon`, transactional `saveWorkspace`

### Phase 4 — Feature surfaces
- [ ] Prompt stacker (save/search/queue, import/export, tags)
- [x] Flip explorer ("spinning door" terminal ↔ file explorer)
- [x] File explorer + sandboxed fs ops
- [ ] Code editor (Canvas2D buffer/tokenizer) — port or reconsider
- [ ] Infinite diagram canvas (rects, connectors, text, tools)
- [ ] Settings, shell landing, tab bar, close-confirm dialog

### Phase 5 — Packaging & polish
- [ ] `deno desktop` release build (macOS first), native WebView
- [ ] `Deno.autoUpdate()` (binary-diff, rollback)
- [ ] `Deno.Tray` / `Deno.Dock` integration
- [ ] Native menus (Edit menu for Cmd+C/V in webview; View menu)
- [ ] Cross-compile check for sidecar

### Phase 6 — AI integration (optional, scope TBD)
- [ ] Decide the AI surface (see Open Questions): inline prompt/command assist, terminal-output explain, or agent orchestration
- [ ] Anthropic SDK in the **Deno backend** only — API key server-side, exposed to the webview via `window.bind()` (streaming over the same push channel as PTY output)
- [ ] Latest Claude models (Opus 4.8 / Sonnet 5 / Haiku 4.5); pick per-task tier
- [ ] **Consult the `claude-api` skill before implementing** (model ids, streaming, tool use, pricing)
- [ ] Ties into the prompt stacker (Phase 4) — AI-generated / AI-refined prompts

---

## Risks

- **PTY streaming path (Phase 1)** — the one truly unproven integration. Mitigated by building it first as a vertical slice.
- **`Deno.serve()` + Deno Desktop coexistence** — need to confirm the WebSocket push channel works with static SPA serving.
- **Deno Desktop is experimental (2.9)** — some platform features still landing; API surface may shift.
- **drizzle-kit on Deno** — needs a community patch; validate before committing to Drizzle for migrations.
- **Sidecar packaging** — shipping + supervising a native helper per platform; guaranteed child-process teardown.

---

## Decisions Log

- **2026-07-03** — Committed to the Locked Stack above. Chose Rust PTY **sidecar** over pure-Deno FFI (correctness + reuse of `pty.rs`; perf bottleneck is rendering, not PTY transport). Chose Vite SPA over SSR meta-frameworks. Build order de-risks PTY streaming in Phase 1.
- **2026-07-03** — **Scorched the old app in-place.** `git rm` of `src/`, `src-tauri/`, build config, and a committed `node_modules/` (3,298 deletions, staged not committed). Preserved to scratchpad seeds: Rust PTY sources (`rust-pty-seed/`) and frontend port-references (`frontend-seed/`: pane-tree, workspace-state, canvas, editor, prompt store, XtermHost). Also retrievable from git history.
- **2026-07-03** — Added to stack: **tinykeys** for hotkeys (replaces hand-rolled `matchKb`), and **optional AI integration** via the Anthropic SDK running server-side in Deno (Phase 6, scope TBD). Noted Deno **2.9+ upgrade** prerequisite (local is 2.7.11).
