# Rust/WASM Terminal Core Migration

> Analysis and phased roadmap for migrating the terminal emulator core (Parser, Screen, VirtualCanvas) from TypeScript to Rust compiled to WASM.

---

## Executive Summary

The terminal emulator core — `Parser.ts`, `Screen.ts`, `VirtualCanvas.ts`, `TerminalCore.ts` — is ~2,200 lines of pure logic with zero browser API dependencies. It can be compiled to WASM and called from the existing TypeScript frontend with no changes to the rendering pipeline (`Renderer.ts`, `GlyphAtlas.ts`, `TerminalHost.ts`).

This migration is primarily an **architecture and correctness** investment. Performance gains are real but narrow — they surface at high throughput (>1 MB/s output), not during interactive use. The more significant wins are: proper UAX #29 Unicode, headless `cargo test` for the emulator, elimination of dual cell-state in Screen, and the foundational architecture needed for every roadmap phase beyond this one.

---

## What Can and Cannot Move

### Permanently browser-native (stays in TypeScript)

| File | Reason |
|---|---|
| `Renderer.ts` | `CanvasRenderingContext2D`, `ctx.drawImage`, font metrics via `ctx.measureText` |
| `GlyphAtlas.ts` | Offscreen `HTMLCanvasElement`, glyph rasterization with `fillText` |
| `TerminalHost.ts` | DOM event listeners, `requestAnimationFrame`, `navigator.clipboard`, canvas management |

These ~1,400 lines stay in TypeScript permanently.

### Pure logic — can move to Rust/WASM (~2,200 lines)

| File | Moveability | Notes |
|---|---|---|
| `Parser.ts` (399 LOC) | 100% | Pure VT500 state machine, zero browser deps |
| `Screen.ts` (1,070 LOC) | 100% | Pure terminal state machine; callbacks become return values |
| `TerminalCore.ts` (153 LOC) | 100% | Wiring layer; moves as consequence of others |
| `VirtualCanvas.ts` (602 LOC) | ~90% | Buffer logic moves; SolidJS signals replaced by dirty bitmap poll |
| `Selection.ts` (70 LOC) | 100% | Pure bounds logic |
| `input.ts` mapping table | Partial | Table moves, event binding stays in JS |

---

## Honest Performance Assessment

### Where WASM helps

| Scenario | Current JS | Rust/WASM | Verdict |
|---|---|---|---|
| Interactive typing / typical command output (<10 KB) | ~0.1 ms | ~0.01 ms | Not felt. RAF at 16 ms dominates. |
| Heavy output (`cat large_file`, compilation) | ~5–20 ms per 64 KB | ~0.5–2 ms | 10–15x. Observable. |
| Extreme sustained throughput (>1 MB/s) | Parser falls behind | Handles it | Real difference. |
| Memory at 5,000-row scrollback | ~400K Cell objects | ~5 MB flat WASM heap | ~5x reduction, near-zero GC pressure |
| Render frame time | Unchanged | Unchanged | Renderer stays in Canvas 2D |

### What WASM does not fix

- **Input latency** — already <1 ms; dominated by `requestAnimationFrame` scheduling (~16 ms). Users will not feel the difference.
- **Rendering speed** — `Renderer.ts` and `GlyphAtlas.ts` stay in Canvas 2D. Frame time is unchanged.
- **The IPC bottleneck** — PTY bytes still cross the Tauri IPC bridge as JSON-serialized strings. That is a separate problem (roadmap Phase 4: binary IPC). A WASM emulator fed by JSON IPC still has the same pipe bottleneck at high throughput.

### Where the real value is

1. **Unicode correctness** — `unicode-segmentation` crate for UAX #29 grapheme cluster segmentation. The current `GRAPHEME_SENTINEL` workaround handles only some cases; proper cluster detection is required for emoji sequences (`👨‍👩‍👧‍👦`), ZWJ sequences, and combining characters.
2. **Headless testing** — `cargo test` can validate the emulator against vttest/esctest recordings with no browser. The iteration loop for emulation bugs drops from minutes to seconds.
3. **Dual-state elimination** — `Screen.ts` currently maintains both `Cell[][]` and writes to `VirtualCanvas`. A Rust emulator writes to one buffer. No sync risk.
4. **Type safety for terminal modes** — 8+ loose boolean mode flags become a `bitflags!` struct. Invalid mode combinations are structurally prevented.

---

## Architecture After Migration

### Current data flow

```
PTY (Rust/Tauri) ──pty-output event──► JS write buffer
  ──► Parser.feed() ──► Screen state machine ──► VirtualCanvas (Uint32Array)
  ──► Renderer.draw(state) ──► Canvas 2D
```

### After migration

```
PTY (Rust/Tauri) ──pty-output event──► JS
  ──► wasm.feed(data)
  ──► re-acquire TypedArray views from WASM memory if needed
  ──► Renderer.draw(state)  ← reads dirty bitmap + buffer views zero-copy from WASM heap
  ──► Canvas 2D
```

The renderer consumes `RenderState` identically. `IRenderer.ts` and `Renderer.ts` do not change.

### WASM memory sharing

`VirtualCanvas`'s `Uint32Array` SoA layout maps exactly to WASM linear memory. The JS renderer reads cell data via TypedArray views pointing into the WASM heap — zero copy, no serialization.

```ts
const memory = wasmModule.memory as WebAssembly.Memory;
const chars = new Uint32Array(memory.buffer, core.chars_ptr(), cols * rows);
```

When WASM memory grows (scrollback accumulation), `memory.buffer` becomes a new `ArrayBuffer`, invalidating views. Views must be re-acquired after each `feed()` call by checking `buffer.byteLength === 0`.

---

## Phased Roadmap

### Phase 0 — Harden the TypeScript Boundary
*No Rust. Prerequisite cleanup. ~2–3 days.*

**0.1 — Resolve the Screen dual-state**

`Screen.ts` maintains `mainBuf: Cell[][]` alongside `VirtualCanvas`. The `print()` method writes to `this.vc.setCell()`, but `getCell()` reads from `this.activeBuf` (Cell[][]). These are not guaranteed in sync and represent ~400K object allocations at full scrollback.

Work: migrate `getCell()` and scrollback reading to use `VirtualCanvas` directly. Once nothing reads Cell[][], delete `mainBuf`, `altBuf`, `activeBuf`, `scrollback` (Cell[][]), `makeBuffer()`, `makeRow()`, `makeBceRow()` from Screen. VirtualCanvas becomes the single cell store.

**0.2 — Define the ITerminalCore contract**

Before writing Rust, define the interface the WASM module will satisfy. `TerminalHost.ts` is updated to speak to this interface — it never changes again during the migration.

```ts
export interface ITerminalCore {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  clearDirty(): void;
  scrollViewport(delta: number): void;
  resetViewport(): void;
  readonly chars: Uint32Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  readonly attrs: Uint32Array;
  readonly ulColor: Uint32Array;
  readonly dirtyBitmap: Uint8Array;
  readonly cursor: { x: number; y: number; visible: boolean; shape: "block" | "underline" | "bar" };
  readonly modes: TerminalModes;
  readonly viewportOffset: number;
  readonly scrollbackLength: number;
  takeResponse(): string | null;
  getSelectedText(selection: Selection): string;
  readonly title: string;
}
```

Refactor the existing `TerminalCore.ts` to implement this interface explicitly.

**0.3 — Build a golden-file test suite for the TS emulator**

Write tests that feed known VT sequences and assert exact VirtualCanvas cell state. These become the correctness specification the Rust port must match.

Minimum coverage:
- SGR attributes (bold, italic, faint, inverse, all underline styles, 256-color, true color)
- CSI cursor movement (CUU/CUD/CUF/CUB/CUP/CHA/VPA)
- Erase operations (ED, EL, ECH) including BCE (background color erase)
- Insert/delete lines (IL/DL), insert/delete chars (ICH/DCH)
- Scroll region setup (DECSTBM) + SU/SD
- Alt screen switch (1047, 1049) with cursor save/restore
- Mouse mode toggling (1000/1002/1003/1006)
- Resize behavior (content preservation, cursor clamp)
- Wide characters (CJK double-wide)
- Grapheme handling (emoji, combining chars)
- `wrapPending` behavior across scroll region boundaries

These tests must pass against the current TS emulator before Phase 2 begins. They run again against Rust throughout Phases 2–5.

---

### Phase 1 — Rust Crate Scaffold + WASM Toolchain
*~1 day. Proves the toolchain before any logic is written.*

**1.1 — Create the `terminal-core` crate**

At repo root, alongside `src/` and `src-tauri/`:

```
terminal-core/
├── Cargo.toml
├── src/
│   ├── lib.rs          ← wasm-bindgen entry points
│   ├── parser.rs
│   ├── screen.rs
│   ├── buffer.rs
│   ├── types.rs
│   └── tests/
│       ├── conformance.rs
│       └── golden/
```

`Cargo.toml` configuration:
```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
unicode-segmentation = "1.12"
console_error_panic_hook = { version = "0.1", optional = true }

[features]
default = ["console_error_panic_hook"]
```

Add `terminal-core` as a workspace member in the root `Cargo.toml`. The Tauri binary (`src-tauri`) never depends on `terminal-core` — they are separate compilation targets.

**1.2 — Integrate wasm-pack into the Vite build**

```json
"scripts": {
  "build:wasm": "wasm-pack build terminal-core --target web --out-dir terminal-core/pkg",
  "dev": "npm run build:wasm && vite",
  "build": "npm run build:wasm && vite build"
}
```

Add `vite-plugin-wasm` to `vite.config.ts`. The WASM output in `terminal-core/pkg/` is imported as a regular ES module.

**1.3 — Ship a no-op stub**

Write `lib.rs` with a `TerminalCore` struct that has no-op implementations of every method in the `ITerminalCore` contract. It compiles, links, and loads in the browser. The terminal will be blank (all no-ops), but the toolchain is proven end-to-end. This is the green build that must be maintained throughout the migration.

**1.4 — Handle WASM memory growth**

WASM linear memory grows as scrollback accumulates. When it grows, `WebAssembly.Memory.buffer` becomes a new `ArrayBuffer`, silently detaching all TypedArray views.

```ts
private acquireViews(): void {
  const buf = (memory as WebAssembly.Memory).buffer;
  this._chars = new Uint32Array(buf, this.wasm.chars_ptr(), this.cols * this.rows);
  this._dirty = new Uint8Array(buf, this.wasm.dirty_bitmap_ptr(), this.rows);
  // etc.
}

write(data: string): void {
  this.wasm.feed(data);
  if (this._chars.buffer.byteLength === 0) this.acquireViews();
}
```

---

### Phase 2 — Port the Parser
*~2 days. Cleanest port — pure state machine, zero side effects.*

**2.1 — Define the handler trait**

The `ParserHandler` TypeScript interface becomes a Rust trait. Parameters are `&[u8]` byte slices internally; only `print()` receives a `char` because printable characters need Unicode handling.

```rust
pub trait ParserHandler {
    fn print(&mut self, ch: char);
    fn execute(&mut self, code: u8);
    fn esc_dispatch(&mut self, intermediates: &[u8], final_byte: u8);
    fn csi_dispatch(&mut self, params: &[i32], intermediates: &[u8], final_byte: u8);
    fn osc_dispatch(&mut self, data: &[u8]);
    fn dcs_dispatch(&mut self, intermediates: &[u8], params: &[i32], data: &[u8]);
    fn apc_dispatch(&mut self, data: &[u8]);
}
```

**2.2 — Port the state machine**

The 18 states in `Parser.ts`'s `const enum S` map 1:1 to a Rust `enum State`. The `next()` method's `switch(state)` becomes `match state { ... }`. The translation is mechanical.

Performance note: the Rust parser processes `&[u8]` bytes directly. For ASCII-dominant terminal output (99% of typical content), there is no UTF-8 decode overhead. The wasm-bindgen `feed(&str)` entry point iterates bytes internally.

**2.3 — Port the SUB_PARAM_MARKER logic**

The colon sub-parameter separator (used for extended underline `58:2:r:g:b`) uses sentinel value `-1` in the params array. This maps to `i32` in Rust with the same sentinel. Keeping identical semantics makes the Screen port a direct translation.

**2.4 — Validate against golden tests**

`tests/conformance.rs` records all dispatched handler calls when feeding golden sequences. Every golden test from Phase 0.3 that exercises parsing (not Screen state) must pass. First `cargo test` green run.

---

### Phase 3 — Port the Buffer
*~2–3 days. Ported before Screen because Screen writes into it.*

**3.1 — Define the buffer structure**

```rust
pub struct TerminalBuffer {
    pub cols: usize,
    pub rows: usize,
    // Active page — Structure of Arrays (matches VirtualCanvas layout exactly)
    pub chars: Vec<u32>,
    pub fg: Vec<u32>,
    pub bg: Vec<u32>,
    pub attrs: Vec<u32>,
    pub ul_color: Vec<u32>,
    // Alt screen
    alt_chars: Vec<u32>,
    alt_fg: Vec<u32>,
    alt_bg: Vec<u32>,
    alt_attrs: Vec<u32>,
    alt_ul_color: Vec<u32>,
    // Dirty tracking
    pub dirty: Vec<u8>,
    // Scrollback
    scrollback: VecDeque<ScrollbackRow>,
    scrollback_limit: usize,
    pub is_alt: bool,
    // Multi-codepoint grapheme side map
    grapheme_map: HashMap<usize, String>,
}
```

`Vec<u32>` has the same memory layout as `Uint32Array` in WASM linear memory. The JS renderer reads zero-copy via TypedArray views. `VecDeque<ScrollbackRow>` enables O(1) push/pop for ring-buffer semantics.

The `batching` flag from `VirtualCanvas.ts` is dropped. It existed solely to batch SolidJS signal updates. With dirty bitmap polling, every `mark_dirty()` is a single byte write — no batching needed.

**3.2 — Port cell operations**

All `VirtualCanvas.ts` methods translate directly to Rust:
- `set_cell()` — identical no-op detection (5-value comparison before write)
- `erase_range()`, `clear_row()` — `slice.fill()`
- `scroll_up()`, `scroll_down()` — `ptr::copy()` or `copy_within` equivalent
- `insert_cells()`, `delete_cells()` — slice shift with `copy_within`
- `push_scrollback()` — grapheme sentinel materialization, same logic
- `switch_to_alt()` / `switch_to_main()` — pointer swap + mark all dirty

**3.3 — Pay the Unicode debt**

Replace the `GRAPHEME_SENTINEL` workaround with proper UAX #29 cluster segmentation using `unicode-segmentation`:

```rust
use unicode_segmentation::UnicodeSegmentation;

fn classify_char(s: &str) -> CharKind {
    let mut clusters = s.graphemes(true);
    let cluster = clusters.next().unwrap_or("");
    let cp_count = cluster.chars().count();
    if cp_count == 1 {
        CharKind::Single(cluster.chars().next().unwrap() as u32)
    } else {
        CharKind::Multi(cluster.to_string())
    }
}
```

Single-codepoint graphemes store inline in `chars[]`. Multi-codepoint graphemes (ZWJ sequences, combining characters) go in `grapheme_map`. The storage layout is unchanged — the detection is now correct. Emoji sequences like `👨‍👩‍👧‍👦` are correctly identified as one cell.

**3.4 — Expose WASM memory pointers**

```rust
#[wasm_bindgen]
pub fn chars_ptr(&self) -> u32 {
    self.screen.buffer.chars.as_ptr() as u32
}
#[wasm_bindgen]
pub fn dirty_bitmap_ptr(&self) -> u32 {
    self.screen.buffer.dirty.as_ptr() as u32
}
// fg_ptr, bg_ptr, attrs_ptr, ul_color_ptr follow the same pattern
```

Return type is `u32` (not `*const u32`) because wasm-bindgen serializes pointer-as-integer for JS.

---

### Phase 4 — Port the Screen State Machine
*~5–7 days. The bulk of the work.*

**4.1 — Data structures and mode flags**

Use `bitflags!` for terminal modes instead of loose booleans:

```rust
bitflags::bitflags! {
    #[derive(Default)]
    pub struct Modes: u32 {
        const AUTO_WRAP          = 1 << 0;
        const APPLICATION_CURSOR = 1 << 1;
        const BRACKETED_PASTE    = 1 << 2;
        const MOUSE_TRACK        = 1 << 3;   // 1000
        const MOUSE_DRAG         = 1 << 4;   // 1002
        const MOUSE_ALL          = 1 << 5;   // 1003
        const MOUSE_SGR          = 1 << 6;   // 1006
        const FOCUS_EVENTS       = 1 << 7;   // 1004
        const ALT_SCREEN         = 1 << 8;
        const ORIGIN_MODE        = 1 << 9;
        const INSERT_MODE        = 1 << 10;
        const CURSOR_VISIBLE     = 1 << 11;
    }
}
```

Invalid mode combinations are structurally prevented. Mouse mode `1003` (any-event) implying `1002` and `1000` can be enforced in `set_private_mode()`.

**4.2 — Port by subsystem, in order of complexity**

Port each group, validate against golden tests after each, before moving to the next.

*C0 controls (`execute`):* BEL, BS, HT, LF/VT/FF, CR, SO/SI. ~10 cases. Start here — validates the handler dispatch chain end-to-end.

*ESC sequences (`esc_dispatch`):* DECSC/DECRC, IND/NEL/RI, HTS, RIS, DECALN, charset designation (G0–G3). ~15 cases.

*CSI cursor movement:* CUU/CUD/CUF/CUB/CUP/CHA/VPA/CNL/CPL. Arithmetic: clamp to `(0, cols-1) × (0, rows-1)`, respecting origin mode.

*CSI erase:* ED (4 modes), EL (3 modes), ECH. BCE (Background Color Erase) applies — erase uses current background color, not default.

*CSI insert/delete:* IL/DL (lines), ICH/DCH (chars). Route to `buffer.insert_cells()` / `buffer.delete_cells()`.

*Scroll region and SU/SD:* `scroll_top` + `scroll_bottom` constrain all line-feed and explicit scroll operations. The scroll region is the most load-bearing piece for TUI apps (Vim, htop).

*SGR — color and attribute parsing:*
1. Reset (0)
2. Basic attributes (1–9, 21–29)
3. Standard FG/BG (30–37, 40–47, 90–97, 100–107)
4. 256-color (`38;5;n`, `48;5;n`)
5. True color (`38;2;r;g;b`, `48;2;r;g;b`)
6. Extended underline styles (`4:0` through `4:5`) via SUB_PARAM_MARKER
7. Underline color (`58:2:r:g:b`)

The color encoding from `types.ts` translates directly: `0` = default, `1–256` = palette, `≥ 0x01_00_00_00` = RGB. All `u32` arithmetic.

*Private modes (`?h` / `?l`):* Full list including 1 (application cursor), 7 (auto-wrap), 12 (blinking cursor), 25 (cursor visibility), 1000/1002/1003 (mouse), 1004 (focus events), 1006 (SGR mouse encoding), 1047/1049 (alt screen), 1048 (save/restore cursor), 2004 (bracketed paste). Note: 1047 vs 1049 distinction — 1049 saves cursor and clears screen; 1047 only switches buffer.

*Device responses (DA1, DA2, DSR, CPR):* Push strings into `self.responses: VecDeque<String>`. The `take_response()` wasm-bindgen method drains the queue. JS polls after each `feed()`.

*OSC dispatch:* Title (0/1/2), clipboard (52). OSC 8 (hyperlinks) can be added here since it is on the roadmap and not yet in the TS emulator.

*DCS and APC passthrough.*

**4.3 — Port `print()` with care**

The `print()` handler has several interlocking concerns that must all be correct:
1. Charset translation (DEC graphics set `glSet`)
2. Check `wrapPending` + autowrap — perform the pending newline before printing
3. Wide character detection
4. Insert mode: shift existing cells right before writing
5. Write cell (and adjacent wide-char half-cell for double-wide chars)
6. Advance cursor; set `wrapPending = true` if cursor reaches `cols - 1`

The `wrapPending` flag is the most commonly misimplemented piece in terminal ports. When the cursor is at column `cols-1` and a character is printed, the cursor stays at `cols-1` — it does not move. The *next* printable character triggers a newline before writing. Printing immediately followed by a CR leaves the cursor on the current line. Get this wrong and every text editor with line wrapping breaks.

---

### Phase 5 — WASM Entry Point and Integration
*~2 days. Wires the Rust core into the live frontend.*

**5.1 — Implement the wasm-bindgen entry point**

`lib.rs` exposes `TerminalCore` to JS with the full set of accessors matching `ITerminalCore`:

```rust
#[wasm_bindgen]
pub struct TerminalCore {
    screen: Screen,  // Screen owns Parser and Buffer
}

#[wasm_bindgen]
impl TerminalCore {
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u32, rows: u32, scrollback_limit: usize) -> Self { ... }

    pub fn feed(&mut self, data: &str) { ... }
    pub fn resize(&mut self, cols: u32, rows: u32) { ... }
    pub fn clear_dirty(&mut self) { ... }
    pub fn scroll_viewport(&mut self, delta: i32) { ... }
    pub fn reset_viewport(&mut self) { ... }
    pub fn take_response(&mut self) -> Option<String> { ... }
    pub fn title_changed(&mut self) -> bool { ... }
    pub fn title(&self) -> String { ... }

    // Buffer pointer accessors
    pub fn chars_ptr(&self) -> u32 { ... }
    pub fn fg_ptr(&self) -> u32 { ... }
    pub fn bg_ptr(&self) -> u32 { ... }
    pub fn attrs_ptr(&self) -> u32 { ... }
    pub fn ul_color_ptr(&self) -> u32 { ... }
    pub fn dirty_bitmap_ptr(&self) -> u32 { ... }

    // Scalar state
    pub fn cursor_x(&self) -> u32 { ... }
    pub fn cursor_y(&self) -> u32 { ... }
    pub fn cursor_visible(&self) -> bool { ... }
    pub fn cursor_shape(&self) -> u8 { ... }  // 0=block 1=underline 2=bar
    pub fn viewport_offset(&self) -> u32 { ... }
    pub fn scrollback_length(&self) -> u32 { ... }

    // Mode flags
    pub fn application_cursor(&self) -> bool { ... }
    pub fn bracketed_paste(&self) -> bool { ... }
    pub fn mouse_enabled(&self) -> bool { ... }
    pub fn mouse_sgr(&self) -> bool { ... }
    pub fn mouse_drag(&self) -> bool { ... }
    pub fn mouse_all(&self) -> bool { ... }
    pub fn is_alt_screen(&self) -> bool { ... }
    pub fn focus_events(&self) -> bool { ... }
}
```

**5.2 — Replace TerminalCore.ts with the WASM adapter**

The existing `TerminalCore.ts` (153 lines) is replaced with a ~100-line TypeScript wrapper that implements `ITerminalCore`:

```ts
import init, { TerminalCore as WasmCore } from "../../terminal-core/pkg";

export class TerminalCore implements ITerminalCore {
  private wasm: WasmCore;
  private _chars!: Uint32Array;
  private _fg!: Uint32Array;
  private _bg!: Uint32Array;
  private _attrs!: Uint32Array;
  private _ulColor!: Uint32Array;
  private _dirty!: Uint8Array;

  static async create(cols: number, rows: number, scrollbackLimit: number): Promise<TerminalCore> {
    await init();
    return new TerminalCore(cols, rows, scrollbackLimit);
  }

  private constructor(cols: number, rows: number, scrollbackLimit: number) {
    this.wasm = new WasmCore(cols, rows, scrollbackLimit);
    this.acquireViews();
  }

  write(data: string): void {
    this.wasm.feed(data);
    if (this._chars.buffer.byteLength === 0) this.acquireViews();
    let r: string | undefined;
    while ((r = this.wasm.take_response()) != null) this.onResponse?.(r);
    if (this.wasm.title_changed()) this.onTitleChange?.(this.wasm.title());
  }

  getRenderState(): RenderState {
    return {
      cols: this.cols, rows: this.rows,
      dirtyRows: this._dirty,
      chars: this._chars,
      fg: this._fg,
      bg: this._bg,
      attrs: this._attrs,
      ulColor: this._ulColor,
      graphemeMap: this.buildGraphemeMap(),
      viewportOffset: this.wasm.viewport_offset(),
      getCell: (r, c) => this.getCell(r, c),
    };
  }

  private acquireViews(): void {
    const buf = wasmMemory.buffer;
    const n = this.cols * this.rows;
    this._chars   = new Uint32Array(buf, this.wasm.chars_ptr(), n);
    this._fg      = new Uint32Array(buf, this.wasm.fg_ptr(), n);
    this._bg      = new Uint32Array(buf, this.wasm.bg_ptr(), n);
    this._attrs   = new Uint32Array(buf, this.wasm.attrs_ptr(), n);
    this._ulColor = new Uint32Array(buf, this.wasm.ul_color_ptr(), n);
    this._dirty   = new Uint8Array(buf, this.wasm.dirty_bitmap_ptr(), this.rows);
  }
}
```

`TerminalHost.ts` is not touched. It calls `core.write()`, `core.getRenderState()`, `core.modes`, `core.cursor` — all satisfied by the adapter implementing `ITerminalCore`.

**5.3 — Async WASM initialization**

WASM modules load asynchronously. `TerminalCore.create()` is async; `Terminal.tsx` awaits it before mounting `TerminalHost`. The loading gap is a blank canvas — the existing dark `#1e1e1e` background in `index.html` covers it invisibly.

---

### Phase 6 — A/B Validation and Cutover
*~1 week of overlap, then cleanup.*

**6.1 — Run TS and WASM emulators in parallel**

Before deleting any TS code, run both on the same PTY stream simultaneously. Use the WASM core for rendering; use the TS core as a reference oracle.

```ts
write(data: string): void {
  this.tsCore.write(data);
  this.wasmCore.write(data);
  this.compareState();
}

compareState(): void {
  const ts = this.tsCore.virtualCanvas.activeChars;
  const wasm = this.wasmCore._chars;
  for (let i = 0; i < this.cols * this.rows; i++) {
    if (ts[i] !== wasm[i]) {
      console.error(`[t-bias] divergence at cell ${i}: TS=0x${ts[i].toString(16)} WASM=0x${wasm[i].toString(16)}`);
    }
  }
}
```

Run this for a week of normal terminal usage — Vim, htop, Claude Code in the terminal. Divergences will surface edge cases: DCS passthrough, unusual SGR resets, 8-bit C1 controls, wrapPending across resize.

**6.2 — Fix divergences**

Each divergence is a discrepancy between TS and Rust behavior. For each:
1. Extract the minimal repro sequence from the divergence log
2. Add it to the golden test suite in `terminal-core/tests/`
3. Fix the Rust behavior to match (or, if TS was wrong, fix both and document why)

**6.3 — Delete the TS emulator**

Once no divergences surface for several days of normal usage:
- Delete `src/terminal/Parser.ts`
- Delete `src/terminal/Screen.ts`
- Delete `src/terminal/VirtualCanvas.ts`
- `TerminalCore.ts` is already the WASM adapter — remove the dual-run code

The emulator surface area in TypeScript drops from ~2,200 lines to ~100 lines.

---

### Phase 7 — Test Infrastructure
*Runs throughout Phases 2–6. The principal DX payoff.*

**7.1 — vttest/esctest integration in `cargo test`**

Feed vttest recording files into the Rust core headlessly. Assert cell buffer state against expected snapshots. No browser, no Tauri — just `cargo test`. Iteration loop for emulation bugs drops from minutes to seconds.

**7.2 — Fuzz testing with `cargo fuzz`**

```rust
fuzz_target!(|data: &[u8]| {
    let mut core = TerminalCore::new(80, 24, 1000);
    if let Ok(s) = std::str::from_utf8(data) {
        core.feed(s);
    }
});
```

Goals: no panics, no UB, no unbounded memory growth. Terminals historically have remote-code-execution vulnerabilities from malformed escape sequences. Fuzzing closes this surface.

**7.3 — Property-based tests with `proptest`**

Properties that must hold for all inputs:
- After any erase operation, all cells in erased range have `char = 0`
- Cursor `x` is always in `[0, cols-1]`; cursor `y` in `[0, rows-1]`
- Resize from `(a, b) → (c, d) → (a, b)` preserves all originally in-bounds cell content
- `sgr(reset)` returns `fg`, `bg` to `DEFAULT_COLOR (0)` and `attrs` to `0`
- Scrollback length never exceeds `scrollback_limit`
- Alt screen switch does not modify main screen buffer content

---

## Phase Dependency Map

```
Phase 0 — Harden TS boundary
    │
    └──► Phase 1 — Rust scaffold + toolchain
               │
               └──► Phase 2 — Port Parser
                         │
                         └──► Phase 3 — Port Buffer
                                   │
                                   └──► Phase 4 — Port Screen
                                             │
                                             └──► Phase 5 — Integration
                                                       │
                                                       └──► Phase 6 — Cutover

Phase 7 — Tests ─────────────────────────────────────────► runs throughout 2–6
```

Phase 0 and Phase 1 can be parallelized — they touch different parts of the codebase. All other phases have hard ordering dependencies.

---

## End State

### Removed from `src/terminal/`

- `Parser.ts`
- `Screen.ts`
- `VirtualCanvas.ts`
- Body of `TerminalCore.ts` (~2,200 lines total removed)

### Added

- `terminal-core/` Rust crate (~1,500 lines)
- `terminal-core/pkg/` WASM build output (generated, gitignored)
- `src/terminal/TerminalCore.ts` replaced by WASM adapter (~100 lines)

### Unchanged

- `src/terminal/Renderer.ts`
- `src/terminal/GlyphAtlas.ts`
- `src/terminal/TerminalHost.ts`
- `src/terminal/IRenderer.ts`
- `src/terminal/input.ts`
- `src/terminal/Selection.ts`
- All of `src-tauri/`

### What this enables downstream

- **Binary IPC (roadmap Phase 4):** PTY bytes can be passed as `ArrayBuffer` directly to `wasm.feed_bytes()` — no string encoding round-trip.
- **Web Worker rendering:** The WASM module can run in a Worker, completely off the main thread. TerminalHost remains on main thread for events; the emulator and renderer run in the worker.
- **Distributable library:** The `terminal-core` crate can be published as a standalone terminal emulation library, equivalent to `alacritty_terminal` or `libghostty`.
- **vttest conformance tracking:** Automated CI over the full vttest suite becomes a single `cargo test` invocation.
