# Activity Monitor learning and explorable computer — 2026-09-20

Continued the read-only monitor with expandable process trees, direct/subtree totals, and saved scope/sort/columns/list-tree preferences. A dedicated versioned SQLite record preserves terminal workspace data and excludes process snapshots, selected PIDs, and search text. Tests cover cycles, deep trees, unavailable counters, persistence, and final preference flush on worker shutdown.

The delegated course author completed the ten-module Inside Your Computer outline and full processes, CPU/time, and memory lessons. These are embedded in a native Learn reader, linked from metric header help, and available offline. The reader owns one scroll handle for keyboard/controller navigation; document and table widths wrap at the minimum window size.

Computer opens a native perspective-projected teaching scene with CPU, RAM, storage, and network stations. It supports controller/keyboard flight, guided station jumps, reset/back, CPU/RAM lesson links, and a 2D alternative. CPU/RAM annotations reuse live monitor snapshots; storage/network are conceptual. This is a simplified educational model, not a guest OS or measured motherboard reconstruction. Rendering uses GPUI primitives with no new engine dependency. Camera ticks run only while moving.

Controller input is consumed by the active learning/world surface. The adapter now sends a neutral stick transition on release; camera controls clear on hide, focus loss, disconnect, and reset.

Verification:

- 72 unit tests passed with the project's pinned toolchain; optimized build passed.
- Native GUI smoke passed live metrics, child-job scoping, terminal restoration, embedded lesson/3D rendering, synthetic controller flight/neutral/reset/back, saved preferences, and no PTY leakage.
- Visual inspection confirmed all four labeled 3D components. Fixed board drawing order, then verified the result.
- Final reader verification confirmed readable wrapping at 1280×852 and Page Down plus wrapped prose/table cells at 640×420. The shared Markdown content helper also removes nested scrolling from the lesson reader.
- `git diff --check` passed. Isolated preview windows were closed; the user's running application and unrelated daily summaries were preserved. The completed course child window was closed.

Outstanding: physical-controller flight, full accessibility/theme review, additional lessons, learning progress, contextual captured examples, deterministic teaching simulations, richer monitor detail history, advanced metrics, measured soak, and Apple Silicon/minimum-OS validation. The distributed signed bundle has not been replaced.
