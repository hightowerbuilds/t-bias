# VirtualCanvas Roadmap: Audit Completion Plan

> Picks up from the virtual-canvas-audit.md analysis. Tracks what's done, what remains,
> and the sequence to get from the current codebase to full audit completion.
>
> Written 2026-04-14. Reference: `daily-growth/Research/virtual-canvas-audit.md`

---

## Status at Starting Point

### Completed (Wave 1 + partial Wave 2)

| ID | Item | Status |
|----|------|--------|
| I1 | Kill the sync bridge | Done — `syncScreenToVirtualCanvas()` deleted |
| I2 | No-op detection in `setCell()` | Done — 5 integer comparisons, early return |
| I3 | Skip grapheme map on fast path | Done — only deletes when old value was `GRAPHEME_SENTINEL` |
| I4 | Bulk scroll with single `copyWithin` | Done — 5 calls total, not 5 × N |
| I5 | Renderer reads typed arrays directly | Done — `drawRowGlyphs/Backgrounds/Decorations` use flat index |
| I11 | VirtualCanvas as sole store | Done — Screen has no `Cell[][]`, all mutations go through VC |
| P12 | Scrollback grapheme materialization | Fixed — `pushScrollback()` materializes sentinels |
| P13 | Grapheme keys on resize | Fixed — `graphemeMap.clear()` on resize |
| P14 | Readonly cast bypass | Fixed — `dirtyBitmap` is a plain mutable field |

### Remaining

| ID | Item | Wave |
|----|------|------|
| P3 | Remove unused Solid signals | 1 |
| P6 | Grapheme map still taxes `clearRow`/scroll | 2 |
| P10/I9 | Sub-row dirty tracking | 3 |
| P11/I12 | Interleaved ArrayBuffer (cache-optimal layout) | 4 |
| P15/I7 | Ring buffer for scrollback | 2 |
| P16 | O(n) scrollback eviction (`Array.shift()`) | 2 |
| P17 | `Uint32Array` for mostly-zero data | 4 |
| P18/I10 | Oversized buffer to avoid resize storms | 3 |
| I6 | Row indirection table (zero-copy scroll) | 3 |
| I8 | Per-row grapheme storage | 2 |
| I9 | Sub-row dirty tracking | 3 |
| I13 | WASM parser + screen | 4 |
| I14 | Compressed scrollback | 4 |
| I15 | Virtual scroll for scrollback | 4 |

---

## Wave 1 — Cleanup

Low-risk removals. No architectural changes. Can be done in a single session.

### 1.1 Remove unused Solid signals (P3)

**What**: Delete `rowVersions`, `rowVersionCounters`, `getRowVersion()`, and the signal-firing
logic in `endBatch()`. Keep `beginBatch()` / `endBatch()` as a batch boundary marker (the
dirty bitmap flush stays), but strip out the `createSignal` machinery.

**Why**: The renderer uses the `Uint8Array` dirty bitmap exclusively. The Solid signals are
created for every row, fired on every batch end, and never consumed. They add allocation
overhead (closures, Solid tracking nodes) and CPU cost (setter calls) for zero benefit.

**Files**: `VirtualCanvas.ts`

**Risk**: Very low. If a future DOM-hybrid mode needs per-row reactivity, signals can be
re-added behind an opt-in flag. Right now they're pure waste.

**Validation**: Run the existing 28 tests. Visually confirm the terminal still renders. Check
that `endBatch()` still sets dirty bitmap entries (it should — that logic is separate from
the signals).

---

## Wave 2 — Scrollback + Grapheme Fixes

These are independent of each other. Can be done in parallel or any order.

### 2.1 Ring buffer for scrollback (P15, P16, I7)

**What**: Replace `ScrollbackRow[]` (array of individual typed-array slices) with a
pre-allocated ring buffer backed by a single `ArrayBuffer`.

**Layout**:
```
One ArrayBuffer: scrollbackLimit × cols × 5 attributes × 4 bytes
Five Uint32Array views over it (chars, fg, bg, attrs, ulColor)
Head index, tail index, count
```

**Operations**:
- **Push**: Write to slot at `tail % capacity`, advance tail. Zero allocation.
- **Evict**: Advance head. No `Array.shift()`, no element movement.
- **Read**: Compute offset from `(head + rowIndex) % capacity * cols`.

**What it eliminates**:
- 25,000 individual typed array allocations at capacity (5 per row × 5,000 rows)
- O(n) `Array.shift()` on every eviction during high-throughput output
- GC pressure from scrollback churn

**Memory**: Same total (~20MB for 5000 × 200 cols) but in one contiguous allocation instead
of 25,000 fragments.

**Files**: `VirtualCanvas.ts` — replace `scrollback: ScrollbackRow[]` with ring buffer
fields, update `pushScrollback()`, `getScrollbackCell()`, `clearScrollback()`,
`trimScrollback()`, `scrollbackLength`.

**Validation**: Existing scroll-related tests. Manual test: `cat` a large file, scroll back
through it, verify content integrity. Verify scrollback wraps correctly at the limit.

### 2.2 Per-row grapheme storage (P6, I8)

**What**: Replace the global `Map<number, string>` (keyed by flat index) with per-row
grapheme maps that travel with their row.

**Design**:
- Each row gets a `graphemes: Map<number, string> | null` field, keyed by **column** (not
  flat index). `null` when no graphemes exist (the common case).
- `setCell()`: If storing a grapheme, lazily create the map for that row. If clearing a
  grapheme, delete from the row's map; set to `null` if empty.
- `clearRow()`: Set the row's grapheme map to `null`. No iteration needed.
- `scrollUp()` / `scrollDown()`: The grapheme map reference moves with the row data
  naturally (it's part of the row, not a global index).
- `resize()`: Per-row maps keyed by column don't break when `cols` changes — out-of-bounds
  columns can be pruned, but the keys are still valid.

**What it eliminates**:
- `clearRow()` iterating all columns to call `graphemeMap.delete()`
- `scrollUp/Down` shifting grapheme entries cell-by-cell across the global map
- The resize-invalidation problem (P13) at the root cause, not the symptom

**Where graphemes are stored for scrollback**: When pushing to the ring buffer (2.1),
materialize grapheme strings into codepoints (already done). The per-row map is discarded
after materialization — scrollback doesn't need it.

**Files**: `VirtualCanvas.ts` — all grapheme-related methods. Minor touch to `Screen.ts`
if `getChar()` signature changes.

**Validation**: Existing tests. Manual test with emoji content (e.g., `echo "🎉🔥"`) — verify
rendering, scrollback, and resize don't corrupt graphemes.

---

## Wave 3 — Structural Upgrades

These build on Wave 2 (especially the ring buffer and per-row graphemes) and deliver the
mid-tier performance wins.

### 3.1 Row indirection table (I6)

**What**: Instead of physically copying cell data during scroll, maintain a
`rowMap: Uint16Array` that maps logical row index to physical row offset in the buffer.

**How scroll works with indirection**:
1. Save `rowMap[top]`'s physical row to scrollback (snapshot the data)
2. `rowMap.copyWithin(top, top + 1, bottom + 1)` — shift the map, not the data
3. Point `rowMap[bottom]` to the freed physical slot
4. Clear that physical slot

**What changes in cell access**: Every cell read/write uses
`rowMap[logicalRow] * cols + col` instead of `logicalRow * cols + col`. One extra integer
array lookup per access.

**What it eliminates**: All `copyWithin()` calls on the 5 cell-data arrays during scroll.
Scroll becomes O(scrollRegionHeight) in the tiny `rowMap` array instead of
O(scrollRegionHeight × cols × 5) in the cell data.

**Trade-off**: One indirection per cell access. Negligible cost (integer array lookup) vs.
the `memmove` it replaces. The renderer already processes cells linearly by row, so the
`rowMap` lookup happens once per row, not once per cell.

**Depends on**: Nothing strictly, but pairs well with per-row graphemes (2.2) since the
grapheme map can be indexed by physical row and doesn't need to move either.

**Files**: `VirtualCanvas.ts` — add `rowMap`, update all cell access and scroll methods.

**Validation**: Full test suite. TUI app testing (scroll-heavy apps like `less`, `vim`).

### 3.2 Sub-row dirty tracking (P10, I9)

**What**: Add column-range tracking alongside the existing row-level dirty bitmap.

**Design**: Column range approach — two `Uint16Array`s:
```
dirtyStart: Uint16Array(rows)  — first dirty column (or cols if clean)
dirtyEnd: Uint16Array(rows)    — last dirty column + 1 (or 0 if clean)
```

**How it works**:
- `markDirty(row)` still sets the bitmap bit (fast "is anything dirty?" check)
- `markDirtyRange(row, colStart, colEnd)` expands the column range for that row
- The renderer's per-row loop adjusts its `col` start/end to the dirty range instead of
  always processing 0..cols
- `clearDirty()` resets both the bitmap and the ranges

**Where to call `markDirtyRange`**: `setCell()` already knows the column. `eraseRange()`
knows start/end. `clearRow()` dirties the full width. Scroll dirties full rows (all columns
shift).

**Expected win**: For a cursor at column 5 on a 200-column row, the renderer processes 1
cell instead of 200 across 3 passes. Status bar updates that touch one side of the screen
skip the other side entirely.

**Files**: `VirtualCanvas.ts` (tracking), `Renderer.ts` (consuming the range).

**Validation**: Existing tests (they don't check column-level dirty, but they verify render
correctness). Manual: type slowly in a shell, confirm only the cursor region redraws (visible
via debug overlay draw time).

### 3.3 Oversized buffer allocation (P18, I10)

**What**: Pre-allocate pages at a generous maximum size and use a logical window into them.
Resize within the allocated bounds costs nothing — just update `cols`/`rows` and mark dirty.

**Design**:
```
Allocated: maxCols × maxRows (e.g., 500 × 200)
Active: this.cols × this.rows (the logical window)
Cell access: row * maxCols + col (stride is maxCols, not cols)
```

- Resize within bounds: update `cols`/`rows`, mark all dirty. No allocation, no copy.
- Resize beyond bounds: reallocate at 2× requested (amortized). Copy existing content.

**Trade-off**: ~8MB pre-allocated (500 × 200 × 5 × 4 bytes × 2 pages) that may not all be
used. Acceptable for a desktop app. Eliminates the allocation burst during window drag-resize
that can fire dozens of times per second.

**Interaction with row indirection (3.1)**: The `rowMap` maps logical rows to physical rows
within the oversized buffer. `maxCols` is the physical stride; `cols` is the logical width.

**Files**: `VirtualCanvas.ts` — change `makePage()` to accept max dimensions, change all
offset calculations to use physical stride.

**Validation**: Resize the window rapidly (drag corner). Confirm no visual glitches, no
allocation spikes (check via debug overlay or DevTools memory timeline).

---

## Wave 4 — Next-Generation Architecture

These are bigger bets that change fundamental access patterns. Each one should be benchmarked
before and after.

### 4.1 Interleaved ArrayBuffer (P11, I12)

**What**: Replace 5 separate `Uint32Array`s per page with a single `ArrayBuffer` where each
cell's attributes are contiguous in memory.

**Layout**:
```
Cell stride: 32 bytes (8 × u32) — 5 used, 3 reserved
Cell at (row, col): offset = (row * cols + col) * 32
  [0]: char (u32)
  [1]: fg (u32)
  [2]: bg (u32)
  [3]: attrs (u32)
  [4]: ulColor (u32)
  [5-7]: reserved (hyperlink ID, image ref, future)
```

**Why 32 bytes**: Power of 2, fits two cells per 64-byte cache line. The renderer reads all
attributes of each cell together — an AoS access pattern. The current SoA layout means 5
cache misses per cell. Interleaved means 1 miss per 2 cells.

**What breaks**: `TypedArray.fill()` for bulk erase of a single attribute. Needs a strided
fill helper. `copyWithin()` for scroll still works (shift entire cell blocks). With row
indirection (3.1), scroll doesn't copy at all.

**Trade-off**: 60% more memory per cell (32 vs 20 bytes). Offset by better cache
utilization. The 3 reserved slots future-proof for hyperlinks (OSC 8), image protocol
(Sixel/Kitty), or other per-cell metadata.

**Depends on**: Ideally done after 3.1 (row indirection) and 3.3 (oversized buffers) are
stable, since it changes every offset calculation.

**Files**: `VirtualCanvas.ts` (storage), `Renderer.ts` (access), `Screen.ts` (writes).

### 4.2 Compact scrollback attributes (P17)

**What**: In the scrollback ring buffer, compress `attrs` and `ulColor` which are >99% zeros.

**Options**:
- **Run-length encoding**: Store `attrRuns: Uint8Array` per row — pairs of (count, value).
  A typical row compresses from 1600 bytes (2 × 200 × 4) to ~10 bytes.
- **Sparse map**: Only store non-default attrs/ulColor positions. Similar to grapheme map
  but for attributes.
- **Bitfield packing**: Pack attrs into a `Uint16Array` (only 12 bits used) and drop
  `ulColor` entirely from scrollback (it's almost never non-default in historical output).

**Memory savings**: At 5,000 rows × 200 cols, attrs + ulColor = 8MB in the ring buffer.
RLE could reduce this to ~50KB for typical terminal output.

**Depends on**: 2.1 (ring buffer) being in place.

### 4.3 WASM parser + screen (I13)

**What**: Rewrite `Parser.ts` and `Screen.ts` in Rust, compile to WASM, and have the Rust
code write directly into a `SharedArrayBuffer` that JavaScript reads for rendering.

**Architecture**:
```
PTY output → Rust WASM (Parser + Screen) → SharedArrayBuffer ← JS Renderer reads
                                          ← JS Input handler writes keyboard sequences
```

**What this buys**:
- Parser hot loop at native speed (~10× for character classification and state transitions)
- Zero serialization between parse and render (shared memory)
- Terminal logic testable with Rust's test infrastructure
- Same Rust code could power a fully native renderer (drop Tauri's webview)

**Prerequisites**:
- I11 done (VirtualCanvas as sole store) — already complete
- Interleaved ArrayBuffer (4.1) ideally done — defines the shared memory layout
- The cell data format must be stable before committing to a binary ABI across the
  JS/WASM boundary

**Effort**: Large. Rewriting ~1,300 lines of Parser + Screen in Rust, designing the
shared memory protocol, handling the async boundary (WASM runs synchronously but PTY
output arrives asynchronously).

**Files**: New `src-wasm/` crate, `VirtualCanvas.ts` becomes a thin JS wrapper over
`SharedArrayBuffer`, `TerminalCore.ts` calls into WASM instead of TS Parser/Screen.

### 4.4 Compressed scrollback + virtual scroll (I14, I15)

**What**: Two-tier scrollback storage with lazy materialization.

**Tier 1 — Hot (recent N rows)**: Full ring buffer (from 2.1). Fast random access for
viewport scrolling near the bottom.

**Tier 2 — Cold (older rows)**: Compressed format:
- `chars: Uint32Array` always stored (needed for text search and selection)
- Attributes run-length encoded (from 4.2)
- Potentially serialized to `IndexedDB` for very large scrollback

**Virtual scroll**: When the user scrolls into cold territory:
- Maintain a viewport cache of materialized rows (visible + a few above/below)
- As the user scrolls, slide the cache window
- Only decompress/materialize rows entering the cache

**Why last**: Most users never scroll back more than 100 lines. The other 4,900 rows sitting
in full-resolution memory is waste, but not urgent waste. Do this when scrollback memory is
a measured problem.

---

## Sequence Summary

```
Wave 1 — Cleanup                                           ✅ DONE 2026-04-14
  1.1  Remove Solid signals (P3)                            ✅

Wave 2 — Scrollback + Graphemes                             ✅ DONE 2026-04-14
  2.1  Ring buffer for scrollback (P15, P16, I7)            ✅
  2.2  Per-row grapheme storage (P6, I8)                    ✅

Wave 3 — Structural Upgrades                                ✅ DONE 2026-04-14
  3.1  Row indirection table (I6)                           ✅
  3.2  Sub-row dirty tracking (P10, I9)                     ✅
  3.3  Oversized buffer allocation (P18, I10)               ✅

Wave 4 — Next-Generation                                    PARTIAL
  4.1  Interleaved ArrayBuffer (P11, I12)                   — Deferred (depends on WebGL/WASM decision)
  4.2  Compact scrollback attributes (P17)                  ✅ DONE 2026-04-14
  4.3  WASM parser + screen (I13)                           — Deferred (large effort, requires stable ABI)
  4.4  Compressed scrollback + virtual scroll (I14, I15)    — Deferred (do when scrollback memory is measured problem)
```

Waves 1–3 and 4.2 completed in a single session on 2026-04-14. All 48 tests pass.

---

## Remaining Work (Wave 4 Deferred Items)

These are architectural bets whose priority depends on product direction decisions:

- **4.1 Interleaved ArrayBuffer**: Changes every access pattern. Only worth doing when
  preparing for WebGL renderer or WASM migration, since it defines the memory ABI.
- **4.3 WASM parser + screen**: Requires stable interleaved buffer layout (4.1), rewrites
  ~1,300 lines of Parser + Screen in Rust. The ultimate performance play but large effort.
- **4.4 Compressed scrollback + virtual scroll**: Two-tier storage (hot/cold) with lazy
  materialization. Do when scrollback memory is a measured problem — most users never
  scroll back more than 100 lines.

---

## Open Questions (Carried Forward)

- **Target grid size?** Optimizations profile differently at 80×24 vs 300×80. Sub-row
  tracking (3.2) and interleaved buffers (4.1) matter more at large sizes.
- **WebGL on the roadmap?** If so, the interleaved ArrayBuffer (4.1) should be designed
  with GPU upload in mind. If Canvas 2D is the long-term renderer, the SoA layout might
  actually be acceptable for bulk operations.
- **WASM timeline?** If WASM (4.3) is near-term, the interleaved buffer layout (4.1) should
  be designed as the shared-memory ABI from the start. If WASM is distant, optimize the
  TypeScript path first and worry about the ABI later.
