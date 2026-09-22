# t-bias — PS2 Controller Terminal Roadmap

**2026-09-21 update:** the [Controller surface roadmap](controller-surface-roadmap.md) now has a working wgpu diagram and button editor, opened from the persistent footer. It includes per-device state, capture/test preview, and saved per-surface assignments. Current routing lives in `WorkspaceView`, config logging is initialized, and stick releases emit neutral transitions. Hardware status and older implementation references below are historical checkpoints, not a current device-support certification. Axis calibration, adapter/transport testing, text entry, and haptics remain later work.

**Goal:** The first terminal emulator designed to be *driven by a PlayStation controller*.
Not a gamepad bolted onto a keyboard app — a terminal whose interaction model assumes two
thumbs, twelve buttons, and two analog sticks, and which is genuinely pleasant to use that way.

**Foundation (already built):** `app/` — `alacritty_terminal` for emulation, GPUI for
GPU-accelerated glyph rendering, `portable-pty` for the shell. See
`gpui-rebuild-roadmap.md`. That stack does not change; this roadmap adds an input
dimension to it.

---

## Why this is tractable

The existing code is, by luck or good taste, already factored for this:

- **`input.rs::encode_key` is pure** — `(key, key_char, mods, app_cursor) -> Option<Vec<u8>>`,
  no GPUI types, unit-tested. The gamepad layer emits *the same `Vec<u8>`*, so everything
  downstream (PTY write, emulator, renderer) is untouched.
- **The background-thread → channel → `cx.spawn` drain → `cx.notify()` pattern already exists**
  twice (`pty_reader_loop`, the flip animation timer). The gilrs poll loop is a third instance
  of a pattern the codebase has already proven.

So the PS2 layer is genuinely *additive*. No rewrite, no fork.

---

## Locked stack (decisions)

- [x] **Gamepad library:** `gilrs = "0.11"` — cross-platform, IOKit/IOHIDManager on macOS,
      hot-plug support, ships the SDL_GameControllerDB mapping database.
- [x] **Threading:** `Gilrs` is `!Send` (holds CoreFoundation types) and pumps a `CFRunLoop`.
      It must be **created and polled on one dedicated thread** — never moved across threads.
      Events cross to the UI over a `futures` unbounded channel, exactly like `AlacEvent`.
- [x] **Device target:** code against an **abstract PlayStation layout** (△○✕□, d-pad,
      L1/L2/R1/R2, L3/R3, Start/Select, two sticks). A DualShock 2 via USB adapter and a
      DualShock 4 over Bluetooth then differ only by a mapping-table entry.
- [x] **Dev hardware:** **DualShock 4** (`054C:05C4`), already paired to this Mac — identical
      button topology to a DS2, available today. *(Currently shows as paired-but-not-connected;
      switch it on before any on-device verification.)*
- [ ] **Text-entry scheme:** **DEFERRED BY DESIGN** — kept behind a `TextEntry` trait so the
      decision can be made by feel, on real hardware, instead of on paper. See Phase 3.

### Known snags (recorded before they bite)

- A cheap **PS2→USB adapter** usually enumerates as a generic HID joystick with **no entry in
  the SDL mapping database**, so gilrs delivers raw unmapped button indices. Solvable with our
  own mapping table — a data problem, not a code problem. Budget an afternoon for it.
- Recent macOS may gate some HID access behind **Input Monitoring** permission. Gamepads are
  usually exempt (that gate targets keyboards), but if events never arrive, check
  System Settings → Privacy & Security → Input Monitoring first.
- **Bluetooth DS4 vs USB DS4 report different HID descriptors.** Test the connection mode you
  intend to ship; don't assume one implies the other.
- **No logger is installed.** `main.rs` never initializes one, so every `log::error!` in the
  codebase — including "gamepad subsystem unavailable" — is silently discarded. Pre-existing,
  but it will bite the moment a controller misbehaves. The toolbar indicator is the Phase 0
  workaround; wiring `env_logger` (or writing to the app-data dir, as the Deno app did) is a
  ~10-line fix worth doing before debugging any real hardware issue.

---

## Phase 0 — Controller spine ⚠️ make-or-break

Scheme-agnostic: every text-entry design needs exactly this. Build it first, learn nothing
the hard way later.

- [x] `app/src/gamepad.rs`: dedicated `tbias-gamepad` thread owning `Gilrs`, polling
      `next_event()` at 125 Hz, forwarding to an `UnboundedSender<PadEvent>`.
- [x] Hot-plug: handles `Connected` / `Disconnected` so the app survives a controller sleeping
      (DS4 sleeps aggressively) and reconnects without a restart. Disconnect also resets stick
      state, so a stale deflection can't scroll forever. Controllers already awake at startup
      are announced explicitly — gilrs only emits `Connected` for devices arriving *after* init.
- [x] Drain the receiver in `Root` via `cx.spawn`, mirroring the `AlacEvent` loop.
- [x] Toolbar shows controller state (`◉ <name>` / `○ no controller`) — the Phase 0 check is
      visual, so it needs to be visible.
- [x] Graceful absence: no controller, or no gamepad subsystem at all, is not an error. The app
      runs keyboard-only exactly as before.
- [x] **VERIFY (headless):** app builds clean, launches, and runs with `tbias-gamepad` alive
      alongside `tbias-pty-reader` / `tbias-pty-writer` — 9 threads, empty stderr, no panic.
      This clears the real runtime risk: `Gilrs` pumping a CFRunLoop from a non-main thread.
- [ ] **VERIFY (on hardware):** switch the DS4 on → toolbar turns green with its name → press
      ○ → the shell takes a `Ctrl-C`. ⚠️ **Blocked on the controller being powered on** — it is
      paired to this Mac but currently asleep.
- [ ] Commit: `feat(ps2-0): gamepad input spine`.

## Phase 1 — Logical pad model

- [x] `PsButton` enum (abstract PlayStation layout) — 16 buttons, deliberately *not* gilrs's
      naming, so DS2-via-adapter and DS4 differ only in how they map onto it.
- [~] Aggregate `PsPad` state struct (buttons held + both stick vectors + analog trigger
      values) — only the internal `StickState` exists so far. The text-entry layer needs the
      full aggregate; build it there rather than speculatively now.
- [~] Mapping layer: gilrs `Button` → `PsButton` done and tested (including the
      bumper/trigger naming trap). The **generic-HID adapter table is not written** — that's
      the DS2 path and needs the adapter in hand to discover real index values.
- [x] Stick handling: radial dead zone with enter/exit hysteresis, 8-way sector quantization
      numbered clockwise from north, angular margin so a wobble near a boundary can't flicker.
- [x] Pure + unit-tested — no gilrs types escape the module; 6 tests covering dead zone, both
      hysteresis axes, cardinals + diagonals, button mapping, and encoder reuse.
- [ ] Analog trigger values (L2/R2 report a 0.0-1.0 travel on a DS4, currently read as binary).
- [ ] Commit: `feat(ps2-1): logical PlayStation pad model`.

## Phase 2 — Terminal verbs (usable without typing)

The high-value, low-risk half. A terminal you can *operate* by pad, even before you can type
into it. Most terminal work is re-running and navigating, not composing prose.

- [x] Right stick → scrollback (`Scroll::Delta`), analog-proportional via a fractional
      accumulator carried between ticks: ~40 lines/sec held hard over, a creep at a nudge.
- [x] D-pad → arrow keys **through `encode_key`**, so application-cursor mode keeps working
      inside vim/less for free rather than being reimplemented.
- [x] ○ → Ctrl-C. △ → Enter. □ → Tab/completion. ✕ → Space.
- [x] L1/R1 → shell history (Up/Down at the prompt).
- [~] **Deviation from plan:** L2/R2 are bound to page-scroll (±10 lines) rather than held
      Ctrl/Alt modifier bits. Held-modifier state needs the aggregate `PsPad` struct that
      Phase 1 deferred; page-scroll is useful today and the binding table is one line to change.
- [ ] Start → command palette, Select → mode switch (deliberately unbound — they belong to the
      modal system in Phase 5, and binding them now would just have to be undone).
- [ ] **VERIFY:** navigate a directory tree, re-run a command from history, and Ctrl-C a
      runaway process — all without touching the keyboard. ⚠️ Blocked on hardware.
- [ ] Commit: `feat(ps2-2): terminal verbs on the pad`.

## Phase 3 — Text entry ⚠️ the real design risk

32+ characters onto 12 buttons. A terminal you cannot type into is a sculpture.

- [ ] Define a `TextEntry` trait: consumes `PsPad` state deltas, emits committed `String`s and
      a HUD render model. **Scheme-pluggable by construction.**
- [ ] **Scheme A — radial chord:** left stick flicks to one of 8 sectors, face button picks one
      of 4 within it (32 chars); L2/R2 shift to caps/symbols/digits. High ceiling (~30 WPM),
      real learning curve.
- [ ] **Scheme B — on-screen grid:** QWERTY grid, d-pad to move, ✕ to select. Instantly
      legible, ~10 WPM, costs screen space.
- [ ] Shared: word prediction / shell completion integration, since a gamepad makes every
      saved keystroke worth far more than it is on a keyboard.
- [ ] **VERIFY:** type `git status`, then something adversarial with symbols and mixed case —
      e.g. `grep -rn "TODO" ~/src | head -3` — measure WPM on each scheme and pick by feel.
- [ ] Commit: `feat(ps2-3): text entry`.

## Phase 4 — HUD & on-screen chrome

- [ ] Radial overlay (only while the stick is deflected — never occupying idle screen).
- [ ] Button legend strip: what △○✕□ do *in the current mode*.
- [ ] Mode indicator; connection/battery state; a clear "controller disconnected" affordance.
- [ ] Render as GPUI elements over the terminal canvas — the flip animation in `main.rs` is the
      reference for compositing over a live grid.
- [ ] Commit: `feat(ps2-4): gamepad HUD`.

## Phase 5 — Modal system

- [ ] Modes: **Navigate** (scroll/select), **Type** (text entry), **Command** (palette/verbs).
      Vim's insight, adapted to a pad — a pad has far fewer inputs than a keyboard, so modes
      are not a stylistic choice here, they're arithmetic.
- [ ] Mode transitions on Select / L3; visible and unambiguous at all times.
- [ ] Per-mode binding tables, data-driven.
- [ ] Commit: `feat(ps2-5): modal input`.

## Phase 6 — Haptics & lightbar (the delight pass)

- [ ] Rumble on: key commit (tiny), command submit, error/bell, process exit.
- [ ] DS4 lightbar reflects mode — an ambient, glanceable state indicator no keyboard can do.
- [ ] Respect a "quiet" config toggle; haptics should be an invitation, not a nuisance.
- [ ] Commit: `feat(ps2-6): haptic and lightbar feedback`.

## Phase 7 — Config & remapping

- [ ] Bindings in the Phase 8 TOML config (see `gpui-rebuild-roadmap.md`) — one config system,
      not two.
- [ ] Per-device mapping profiles (DS2-adapter, DS4, DS5) shipped as defaults.
- [ ] In-app remapping UI: press a button, bind it.
- [ ] Commit: `feat(ps2-7): gamepad config`.

## Phase 8 — Workspace control by pad

Depends on the GPUI roadmap's Phase 4 UI (tabs/splits) existing and being wired.

- [ ] L1/R1 (or d-pad + modifier) cycles tabs; stick-flick navigates panes.
- [ ] Split / zoom / close bound to chords.
- [ ] Commit: `feat(ps2-8): workspace navigation by pad`.

---

## Working principles

- [ ] **De-risk order:** spine → pad model → verbs → typing. Do NOT design the radial keyboard
      before a button has moved the shell. (Same discipline that made the GPUI rebuild work.)
- [ ] **Keep the keyboard fully functional.** The pad is an *additional* input source, never a
      replacement. Every feature must remain reachable by keyboard.
- [ ] **Pure, testable input layers.** `input.rs` is the template: no library types in the
      model, fiddly mappings pinned by unit tests rather than eyeballed in a running app.
- [ ] **Verify on real hardware.** A gamepad interaction model cannot be evaluated headlessly —
      WPM and "does this feel good" are the actual acceptance criteria.
- [ ] **Commit per phase**, matching the `ps2-N` tags above.
