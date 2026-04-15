# VirtualCanvas Audit: Problems, Ideas, and Design Direction

> A thorough analysis of the current VirtualCanvas implementation — what's broken, what's
> wasteful, what's clever but undermined, and where we should go next.
>
> Written 2026-04-14. Intended as a living reference for the other agent doing the coding
> and for review sessions between coding passes.

---

## Table of Contents

1. [Current Architecture Summary](#current-architecture-summary)
2. [Problems](#problems)
   - [Structural / Identity Problems](#structural--identity-problems)
   - [Performance Problems](#performance-problems)
   - [Correctness Problems](#correctness-problems)
   - [Memory Problems](#memory-problems)
3. [Ideas](#ideas)
   - [Quick Wins (Minimal Refactor)](#quick-wins-minimal-refactor)
   - [Medium-Effort Structural Changes](#medium-effort-structural-changes)
   - [Big Bets (Architecture-Level)](#big-bets-architecture-level)
4. [Decision Framework](#decision-framework)
5. [Recommended Sequence](#recommended-sequence)

---

## Current Architecture Summary

VirtualCanvas sits between Screen (the terminal state machine) and the Renderer. It stores
cell data in a Structure-of-Arrays layout using typed arrays (`Uint32Array` for chars, fg,
bg, attrs, ulColor), tracks dirty rows via a `Uint8Array` bitmap, and holds Solid.js signals
per row for reactive change notification.

The data flow today:

```
PTY output → Parser → Screen (writes to Cell[][] AND calls vc.setCell())
                          ↓
                   TerminalCore.syncScreenToVirtualCanvas()
                     (overwrites ALL cells from Cell[][] → typed arrays)
                          ↓
                   Renderer reads state.getCell() → allocates Cell objects → draws
```

VirtualCanvas owns:
- Two BufferPages (main + alt), each with 5 flat `Uint32Array`s
- A `Map<number, string>` grapheme map for multi-codepoint characters
- A scrollback array of `ScrollbackRow` objects (5 typed arrays each)
- A `Uint8Array` dirty bitmap + `Uint32Array` version counters + Solid signals per row
- Methods for cell access, row copy, scroll, clear, resize, alt screen switching

**The core tension**: VirtualCanvas was designed to be the primary data store, but Screen
still owns `Cell[][]` as the authoritative state. VirtualCanvas is a mirror that gets
bulldozed by a full-grid sync every frame. Most of its machinery (incremental dirty tracking,
Solid signals, efficient typed array operations) is undermined by this arrangement.

---

## Problems

### Structural / Identity Problems

#### P1. Dual representation with full-grid sync

Screen maintains `Cell[][]` (Array-of-Structures, heap objects). VirtualCanvas maintains
typed arrays (Structure-of-Arrays). Every mutation pays three times:

1. Screen writes to `this.activeBuf[row][col] = { char, fg, bg, ... }`
2. Screen calls `this.vc?.setCell(row, col, ...)` (incremental typed array update)
3. `TerminalCore.syncScreenToVirtualCanvas()` iterates all `rows × cols` and copies
   everything from Screen → VirtualCanvas again

The sync bridge at `TerminalCore.ts:66-74` is O(rows × cols) per frame regardless of how
many cells actually changed. On a 200×50 grid, that's 10,000 cells touched to update 1.

**Impact**: The incremental `vc.setCell()` calls from Screen are completely wasted. The dirty
bitmap is always fully set. The entire point of change tracking is negated.

#### P2. VirtualCanvas doesn't own its role

The class tries to be three things at once:
- A typed-array data store (the BufferPage arrays)
- A reactive change-notification system (Solid signals + dirty bitmap)
- A scrollback manager (with its own storage, eviction, and access methods)

But it doesn't fully own any of these roles because Screen duplicates all of them with
`Cell[][]`, its own scrollback array, and its own getCell/erase/scroll operations.

#### P3. Solid signals are created but likely never consumed

`endBatch()` at line 316 fires a signal setter for every dirty row. This triggers Solid's
reactivity system — dependency tracking, signal graph updates, potential effect scheduling.

But the renderer reads from `RenderState.dirtyRows` (the `Uint8Array` bitmap), not from
Solid signals. Unless something else calls `getRowVersion()` and subscribes, the signals
are pure overhead: memory for closures, Solid tracking nodes, and setter calls on every
batch — all for nothing.

**Question to resolve**: Are these signals intended for a future DOM-hybrid rendering mode
(e.g., Solid `<For>` over rows)? If so, document that intent. If not, they should go.

#### P4. The renderer reads through getCell(), not the typed arrays

`RenderState` exposes both `getCell(row, col): Cell` (object allocation) and direct typed
array references (`chars`, `fg`, `bg`, `attrs`, `ulColor`, `graphemeMap`). But `Renderer.ts`
exclusively uses `state.getCell()` — it never touches the typed arrays.

The typed arrays exist specifically to enable zero-allocation rendering. The renderer ignores
them. VirtualCanvas pays the cost of maintaining them for no benefit.

---

### Performance Problems

#### P5. Scroll uses row-by-row copy instead of bulk shift

`scrollUp()` loops from `top` to `bottom`, calling `copyRow()` on each iteration.
`copyRow()` does 5 `copyWithin()` calls + a full-width grapheme map scan per row.

A 50-row scroll region = 250 `copyWithin()` calls + 50 × cols grapheme map iterations.

But `TypedArray.copyWithin()` on a contiguous range is a single `memmove` internally. The
entire region could be shifted in 5 bulk `copyWithin()` calls total:
```
chars.copyWithin(topOffset, topOffset + cols, bottomOffset + cols)  // one call
```
instead of N individual row copies.

#### P6. Grapheme map taxes every operation even when empty

`clearRow()` iterates all `cols` positions calling `this.graphemeMap.delete(c)` — even when
the row has zero graphemes (the overwhelmingly common case).

`copyRow()` does `cols` get/set/delete operations on the Map per row.

For a 200-column terminal, that's 200 `Map.delete()` calls per row during scroll, just to
handle the case where maybe one cell has an emoji. ASCII content (95%+ of terminal usage)
pays the full cost of the Unicode edge case.

**The real cost**: Map operations involve hash computation, bucket lookup, and (for delete)
re-indexing. This isn't free — it's measurably slower than the `copyWithin()` calls it sits
next to.

#### P7. setCell() hot path has unnecessary work

`setCell()` is the hottest function in the system — called for every visible character during
parsing. On every call it:

1. Computes the flat index (fine)
2. Runs a confusing surrogate-pair detection branch (lines 102-116)
3. Calls `this.graphemeMap.delete(idx)` on the fast path — even when there was never a
   grapheme there (Map.delete on a missing key still hashes and looks up)
4. Writes to 5 typed array positions (necessary)
5. Calls `markDirty(row)` (necessary, but see P9)

Items 2 and 3 are overhead on every keystroke. The surrogate pair logic is also genuinely
hard to verify as correct by reading — the nested ternary at line 105 is a maintenance
hazard.

#### P8. getCell() allocates an object per call

The renderer hits `getCell()` for every cell across 3 rendering passes (backgrounds, glyphs,
decorations). A full redraw of a 200×50 grid: 3 × 10,000 = 30,000 fresh
`{ char, fg, bg, attrs, ulColor }` objects. All immediately discarded.

Each call also does `String.fromCodePoint()` — another string allocation. So that's 30,000
objects + 30,000 strings per full frame, all short-lived GC pressure.

#### P9. No-op writes still mark dirty

If Screen rewrites a cell with identical content (extremely common — status bars, prompts,
full-screen redraws by TUI apps), `setCell()` marks the row dirty unconditionally. The
renderer then redraws a row that produces identical pixels.

There's no comparison against the previous value. Adding 5 integer comparisons (chars, fg,
bg, attrs, ulColor) to the write path would eliminate most unnecessary redraws for
interactive terminal usage.

#### P10. Dirty granularity is row-level only

One cell change dirties the entire row. On a 300-column terminal, a single character edit
triggers the renderer to process all 300 cells across 3 passes = 900 cell reads. Sub-row
tracking could reduce this dramatically for the common case (cursor at one position,
status bar update on one side of the screen).

#### P11. Five typed arrays = five cache lines per cell read

Reading one cell touches `chars[idx]`, `fg[idx]`, `bg[idx]`, `attrs[idx]`, `ulColor[idx]`.
These are five different memory regions, each `cols × 4` bytes apart. On a 200-column
terminal, consecutive array positions for the same cell are ~800 bytes apart — they won't
share a cache line.

The SoA layout is great for bulk scans of a single attribute (e.g., "fill all bg values").
But the renderer reads all five attributes of each cell together, which is an AoS access
pattern. The layout and the access pattern are mismatched.

---

### Correctness Problems

#### P12. Scrollback loses graphemes

`pushScrollback()` copies the raw `chars` typed array including `GRAPHEME_SENTINEL` (0xFFFFFFFF)
values, but does NOT copy the corresponding grapheme map entries for that row.

The comment at line 275 acknowledges this:
```
// Materialize graphemes into the chars array as sentinel + we skip graphemeMap for scrollback
// (scrollback getCell doesn't use graphemeMap — just stores codepoints)
```

But the code doesn't actually materialize anything. It just copies the sentinel value.
`getScrollbackCell()` then calls `String.fromCodePoint(0xFFFFFFFF)` on those cells, which
produces garbage. Any emoji or combining characters in scrollback are corrupted.

#### P13. Grapheme map keys break on resize

Grapheme map keys are flat indices: `row * cols + col`. When `resize()` changes `cols`,
existing keys map to wrong positions.

The cleanup at line 383 tries to handle this:
```ts
for (const key of this.graphemeMap.keys()) {
  const r = Math.floor(key / newCols);
  const c = key % newCols;
  if (r >= newRows || c >= newCols) {
    this.graphemeMap.delete(key);
  }
}
```

But this recomputes row/col using `newCols` — the key was computed using `oldCols`. The math
is wrong. Example: with oldCols=80, a grapheme at row 5 col 3 has key 403. If newCols=100,
the cleanup computes `Math.floor(403 / 100) = 4` (wrong row) and `403 % 100 = 3` (coincidentally
right col but for the wrong row). The grapheme survives cleanup but is now associated with
the wrong cell.

#### P14. resize() casts away readonly

Line 379: `(this as any).dirtyBitmap = new Uint8Array(newRows)` — bypasses the `readonly`
modifier via an `any` cast. This means external code holding a reference to the old
`dirtyBitmap` array will be reading stale data after resize. The renderer gets
`state.dirtyRows` from `getRenderState()` — if it holds that reference across a resize,
it reads the old (orphaned) bitmap.

---

### Memory Problems

#### P15. Scrollback is 25,000 individual typed array allocations

Each `ScrollbackRow` is 5 `Uint32Array.slice()` calls — 5 separate heap objects. At 5,000
rows of scrollback = 25,000 typed arrays the GC must track.

For 200 columns: each `Uint32Array` is 800 bytes, each row is ~4KB across 5 scattered
allocations. Total: ~20MB, but fragmented across 25,000 objects with no locality between
them.

#### P16. Scrollback eviction is O(n)

`Array.shift()` on the scrollback array removes the oldest row but must shift all remaining
elements down by one index. At 5,000 rows, that's 5,000 pointer moves per eviction.

During `cat bigfile.txt`, scrollback fills quickly and every subsequent line triggers an
O(5000) shift. This compounds with the allocation cost of the new `ScrollbackRow` being
pushed.

#### P17. Uint32Array per attribute is 4 bytes for often-1-bit data

`attrs` is a bitfield that's almost always 0 (no attributes) and rarely exceeds 12 meaningful
bits. `ulColor` is almost always `DEFAULT_COLOR` (0). Both get 4 bytes per cell via
`Uint32Array`.

On a 200×50 grid: attrs and ulColor together = 80KB for data that's >99% zeros. Not a crisis,
but worth noting for scrollback where it multiplies by thousands.

#### P18. Resize allocates entirely new pages

`resize()` creates fresh `BufferPage`s (5 new typed arrays each × 2 pages = 10 allocations),
copies cell-by-cell in nested loops, rebuilds the signal array, rebuilds the dirty bitmap,
and iterates the entire grapheme map.

During window drag-resize, this fires potentially dozens of times per second. Each invocation
is a burst of allocation + copy + GC of the old pages.

---

## Ideas

### Quick Wins (Minimal Refactor)

#### I1. Kill the sync bridge — trust the incremental path

Delete `TerminalCore.syncScreenToVirtualCanvas()` entirely. Screen already calls
`vc.setCell()`, `vc.scrollUp()`, `vc.scrollDown()`, `vc.clearRow()`, `vc.switchToAlt()`,
etc. on every mutation. The incremental path is already wired up — the sync bridge is
redundant.

**Risk**: Any Screen operation that forgets to call `vc.*` will produce stale rendering.
Need to audit every mutation point in Screen.

**Effort**: Small. Delete one method, audit Screen for coverage gaps.

**Impact**: Eliminates O(rows × cols) per-frame overhead. Dirty bitmap becomes accurate.
Rows that didn't change stop being redrawn.

#### I2. No-op detection in setCell()

Before writing, compare the new values against what's already stored:
```
if (page.chars[idx] === newCp && page.fg[idx] === fg && page.bg[idx] === bg
    && page.attrs[idx] === attrs && page.ulColor[idx] === ulColor) return;
```

Five integer comparisons on the write path. Saves an entire row's worth of rendering when
content doesn't change. Massive win for status bars, prompts, and TUI apps that redraw
unchanged content (which is most of them — htop, vim, tmux all do this constantly).

#### I3. Skip grapheme map delete on fast path

In `setCell()`, only call `this.graphemeMap.delete(idx)` if `page.chars[idx]` was previously
`GRAPHEME_SENTINEL`. One comparison to avoid a hash-map operation on every cell write.

Similarly, in `clearRow()` and `copyRow()`, skip grapheme iteration when the row has no
sentinels. Could track this with a per-row "has graphemes" flag, or just scan the chars
array for `GRAPHEME_SENTINEL` before iterating.

#### I4. Bulk scroll with single copyWithin per array

Replace the row-by-row loop in `scrollUp()`:
```ts
// Current: N calls per array
for (let r = top; r < bottom; r++) this.copyRow(r, r + 1);

// Proposed: 1 call per array
const sOff = (top + 1) * cols;
const dOff = top * cols;
const len = (bottom - top) * cols;
page.chars.copyWithin(dOff, sOff, sOff + len);
page.fg.copyWithin(dOff, sOff, sOff + len);
// ... same for bg, attrs, ulColor
```

Five `copyWithin()` calls total instead of 5 × N. Then handle graphemes separately (only
for rows that contain sentinels).

#### I5. Make the renderer read typed arrays directly

The renderer already has access to `state.chars`, `state.fg`, etc. via `RenderState`. Change
`drawRowBackgrounds()`, `drawRowGlyphs()`, and `drawRowDecorations()` to compute
`idx = row * cols + col` and read directly from typed arrays instead of calling
`state.getCell()`.

Eliminates 30,000 object allocations + 30,000 `String.fromCodePoint()` calls per full frame.

For the char string (needed by the glyph atlas), only convert when the cell is non-empty and
not hidden. Cache the conversion or use the grapheme map lookup only for sentinel values.

---

### Medium-Effort Structural Changes

#### I6. Row indirection table — zero-copy scroll

Instead of physically moving data when scrolling, maintain a `rowMap: Uint16Array` that maps
logical row → physical row offset in the buffer.

Scrolling up becomes:
1. Save `rowMap[top]` to scrollback (snapshot that physical row)
2. Shift the map entries: `rowMap.copyWithin(top, top + 1, bottom + 1)`
3. Point `rowMap[bottom]` to the freed physical slot
4. Clear that physical row

**Zero data movement** for the actual cell content. Five `copyWithin()` calls become zero.
The renderer uses `rowMap[logicalRow] * cols + col` as the index instead of
`logicalRow * cols + col`.

**Trade-off**: One indirection per cell access. But it's an integer array lookup, which is
essentially free compared to the memcpy it replaces.

#### I7. Ring buffer for scrollback

Replace `ScrollbackRow[]` with a pre-allocated ring buffer:

```
One large ArrayBuffer: scrollbackLimit × cols × 5 attributes × 4 bytes
Head pointer, tail pointer, count.
```

Push: write to slot at tail, advance tail (mod capacity). No allocation.
Evict: advance head. No `Array.shift()`. No element movement.
Read: compute offset from head + row index.

Eliminates: 25,000 individual typed array allocations, O(n) shift on eviction, GC pressure
from scrollback churn.

**Memory**: For 5000 rows × 200 cols: 5000 × 200 × 5 × 4 = 20MB. Same total as today but
in one contiguous allocation instead of 25,000 fragments.

#### I8. Per-row grapheme storage

Replace the global `Map<number, string>` with grapheme data attached per row. Options:

- **A**: `graphemes: Map<number, string> | null` per row (null when no graphemes — the
  common case). Key is column index, not flat index. Scroll moves the map reference with the
  row. Resize doesn't break keys.

- **B**: With row indirection (I6), the grapheme map keys become `physicalRow * cols + col`.
  Physical rows don't move during scroll, so the keys stay valid.

Either approach fixes P6 (unnecessary iteration) and P13 (keys breaking on resize).

#### I9. Sub-row dirty tracking

Replace the `Uint8Array` bitmap with one of:

- **Tile bitmap**: `Uint32Array` per row, each bit = 8-column tile. A 256-column row needs
  1 u32. Renderer skips unchanged tiles.
- **Column range**: `Uint16Array` with `[dirtyStart, dirtyEnd]` per row. Renderer only
  processes the changed column range.
- **Dual bitmap**: Keep the row-level `Uint8Array` (fast check for "anything dirty?") and
  add a column bitmask for rows that are dirty (detailed "where?").

Best bang for buck is probably the column range — two u16s per row, minimal memory, and the
renderer's existing per-cell loop just adjusts its start/end bounds.

#### I10. Oversized buffer allocation to avoid resize storms

Allocate pages at a generous maximum size (e.g., 500 cols × 200 rows) and use a window into
them defined by `this.cols` and `this.rows`. When resize happens:

- If new size fits within the allocated maximum: just update `cols`/`rows` and mark all dirty.
  No allocation, no copy.
- If new size exceeds the maximum: reallocate at 2× the requested size (amortized resizing).

Eliminates the allocation burst during window drag-resize. The trade-off is ~2MB of
pre-allocated memory that may not all be used.

---

### Big Bets (Architecture-Level)

#### I11. Make VirtualCanvas THE store (kill Cell[][])

The fundamental reframing. Screen should not have `Cell[][]` at all. VirtualCanvas becomes
the sole backing store. Screen becomes a set of operations that mutate VirtualCanvas directly.

What changes:
- `Screen.print()` writes to `vc.setCell()` only — no `activeBuf[row][col] = ...`
- `Screen.getCell()` reads from VirtualCanvas — no `activeBuf[row][col]`
- All erase/insert/delete/scroll operations work through VirtualCanvas methods
- `TerminalCore` drops the sync bridge entirely
- The `Cell` interface becomes a read-time convenience, never a storage format

What this unlocks:
- Single source of truth — no divergence bugs
- Dirty tracking is automatically precise
- Every optimization to VirtualCanvas directly benefits parsing speed
- Path to SharedArrayBuffer (Rust writes directly to the buffer)

**This is the endgame**. Everything else is incremental improvement. This is the structural
change that makes the architecture coherent.

#### I12. Single interleaved ArrayBuffer

Instead of 5 separate `Uint32Array`s per page, use one `ArrayBuffer` with a per-cell stride:

```
Cell layout: [char:u32, fg:u32, bg:u32, attrs:u32, ulColor:u32] = 20 bytes
Cell at (row, col): offset = (row * cols + col) * 20
```

All five attributes of one cell are on the same cache line (64 bytes fits 3 cells). This
matches the renderer's AoS access pattern — it reads all attributes of each cell together.

**Trade-off**: You lose `TypedArray.fill()` for bulk erase of a single attribute. But you
can write a small helper that fills a stride pattern, or use `DataView` for individual
attribute access.

**Why this matters**: Cache locality dominates performance for the renderer's inner loop.
Five scattered arrays means five cache misses per cell. One interleaved buffer means one
cache miss per 3 cells.

**Variant**: Use an `ArrayBuffer` but create overlapping typed array views at different
offsets. You can have both interleaved storage and per-attribute access — but only if the
stride is a multiple of the typed array element size, which 20 bytes is not. You'd need
to pad to 24 bytes (6 × u32, one wasted) or 32 bytes (8 × u32, three wasted) to get clean
view alignment. 32 bytes per cell might be worth it: 8 u32 slots, 3 reserved for future
attributes (URL hyperlink ID, image cell reference, etc.).

#### I13. Move parser + screen to WASM

The parser and screen state machine are pure computation — no DOM, no browser APIs. This is
a textbook WASM candidate.

Architecture:
- Rust module with Parser + Screen logic
- Writes directly into a `SharedArrayBuffer` that JS can read
- JS side only does rendering (Canvas 2D / WebGL) and input handling
- VirtualCanvas becomes a thin JS wrapper over the shared memory

What this buys:
- Parser runs at native speed (~10× faster for the hot loop)
- Zero serialization between parse and render (shared memory)
- Terminal logic can be tested with Rust's testing infrastructure
- Same Rust code could power a native renderer (no Tauri needed)

**Timing**: This should come after I11 (VirtualCanvas as sole store) because it requires
the typed array layout to be the authoritative format. If Screen still uses `Cell[][]`, the
WASM boundary would need to serialize objects, defeating the purpose.

#### I14. Compressed scrollback with lazy materialization

Most scrollback rows are mostly default-attributed. Store scrollback in two tiers:

**Tier 1 — Hot (recent N rows)**: Full typed arrays, same format as active buffer. Fast
random access for viewport scrolling.

**Tier 2 — Cold (older rows)**: Compressed format per row:
- `chars: Uint32Array` (always stored — needed for text search/selection)
- `attrRuns: Uint8Array` — run-length encoded attribute overrides. Most cells share the
  same fg/bg/attrs, so runs compress well. A typical scrollback row might compress from
  4KB (5 arrays × 200 × 4 bytes) to ~900 bytes (chars + a few attribute runs).

When the user scrolls into cold territory, decompress on demand into a temporary buffer for
rendering.

**Even more aggressive**: Don't even keep cold rows in memory. Serialize to an
`ArrayBuffer` pool or `IndexedDB`. Deserialize on scroll. Most users never scroll back more
than 100 lines — the other 4,900 rows are wasted memory.

#### I15. Virtual scroll for scrollback rendering

When the user scrolls into scrollback, don't render the entire visible grid from scrollback
data. Instead:

- Keep a small "viewport cache" of materialized rows (the visible rows + a few above/below)
- As the user scrolls, slide the cache window
- Only materialize rows that enter the cache

This pairs with I14 (compressed cold storage) — you only decompress what's visible.

---

## Decision Framework

When evaluating which ideas to implement and in what order, use these criteria:

| Criterion | Weight | Meaning |
|-----------|--------|---------|
| Unblocks other work | High | Does this make other improvements possible or easier? |
| Reduces complexity | High | Does this remove dual state, special cases, or sync logic? |
| Measurable perf win | Medium | Can we benchmark before/after and see a clear difference? |
| Correctness fix | Medium | Does this fix actual bugs (P12, P13, P14)? |
| Effort | Medium | How many files change? How much risk of regression? |
| Future-proofs | Low | Does this move toward WASM/SharedArrayBuffer/WebGL? |

Ideas that **unblock other work** and **reduce complexity** should go first, even if their
direct performance impact is modest. The sync bridge (I1) is the clearest example: killing
it doesn't make rendering faster by itself, but it makes dirty tracking work, which makes
every subsequent optimization land properly.

---

## Recommended Sequence

### Wave 1 — Stop the bleeding

These can be done independently and in any order. Minimal risk, immediate benefit.

1. **I1: Kill the sync bridge** — Biggest architectural cleanup. Unblocks accurate dirty
   tracking. Audit Screen for `vc.*` coverage gaps first.
2. **I2: No-op detection in setCell()** — 5 comparisons, eliminates most redundant redraws.
3. **I3: Skip grapheme map on fast path** — One conditional, removes hot-path hash map ops.
4. **I4: Bulk scroll** — Replace row loop with single copyWithin per array.

### Wave 2 — Structural fixes

These depend on Wave 1 (particularly I1) being done.

5. **I5: Renderer reads typed arrays** — Eliminates 30k object allocations per frame.
   Requires I1 so the typed arrays are authoritative.
6. **P12 fix: Scrollback grapheme materialization** — Correctness bug. Fix either by
   materializing graphemes into the chars array at push time, or by copying the relevant
   grapheme map entries.
7. **P13 fix: Grapheme key scheme** — Either adopt per-row grapheme storage (I8) or fix
   the resize key recomputation.
8. **I7: Ring buffer for scrollback** — Eliminates O(n) eviction and allocation churn.

### Wave 3 — Architecture convergence

9. **I11: VirtualCanvas as sole store** — The big refactor. Screen drops `Cell[][]`.
   VirtualCanvas becomes the truth. Everything else gets simpler.
10. **I6: Row indirection table** — Zero-copy scroll. Pairs naturally with I11.
11. **I9: Sub-row dirty tracking** — Precision rendering. Biggest win with I11 in place.
12. **I10: Oversized allocation** — Smooth resize. Simple once I11 stabilizes.

### Wave 4 — Next-generation

13. **I12: Interleaved ArrayBuffer** — Cache-optimal layout. Do this when preparing for
    WebGL or WASM, since it changes every access pattern.
14. **I13: WASM parser + screen** — The ultimate performance play. Requires I11 + I12.
15. **I14 + I15: Compressed scrollback + virtual scroll** — Memory optimization. Do this
    when scrollback is actually a measured problem.

---

## Open Questions

- **Are the Solid signals needed?** If the rendering path is purely imperative (dirty bitmap →
  requestAnimationFrame → draw), Solid signals per row add overhead for no subscriber. If
  there's a planned DOM-hybrid mode (e.g., overlaying Solid components on terminal cells),
  they're justified. Decide and either commit to using them or remove them.

- **Should VirtualCanvas own scrollback at all?** Currently both Screen and VirtualCanvas
  maintain independent scrollback. If VirtualCanvas becomes the sole store (I11), it must
  own scrollback. But until then, the duplication is confusing and error-prone.

- **What's the target grid size?** Optimizations have different profiles at 80×24 vs 300×80.
  If the target is "typical developer terminal" (120×40 = 4,800 cells), many of these
  optimizations are nice-to-have. If the target includes large multiplexed layouts (300×80 =
  24,000 cells) or high-DPI 4K fullscreen, they become necessary.

- **Is WebGL on the roadmap?** If so, the interleaved ArrayBuffer (I12) should be designed
  with GPU upload in mind — it could double as a vertex buffer or texture data source. If
  Canvas 2D is the long-term renderer, the SoA layout might actually be fine since batch
  operations (fill, copyWithin) work better with it.
