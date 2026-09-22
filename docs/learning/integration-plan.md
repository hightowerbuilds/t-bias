# Activity Monitor learning and the explorable computer

**Design draft, 2026-09-20.** This document describes integration targets and acceptance criteria. A checked implementation status belongs in the application roadmap; this draft does not certify that a feature has shipped. The first three lesson sources are [processes](01-processes.md), [CPU](02-cpu-and-time.md), and [memory](03-memory.md).

## Learning inside the monitor

Give the Activity Monitor a **Learn** entry that opens a native reader with three starter lessons and a course index. The learner should keep their place in the process table and return without losing search, scope, sort, or selection. Use existing immutable monitor snapshots for examples; do not create a second collector for the reader or the 3D world.

Start with `include_str!`-embedded Markdown and stable IDs `processes`, `cpu`, `memory`. Put presentation state in its own model; the lesson text should not contain executable actions. Later, move structured exercises and glossary metadata into a small validated content format if the reader needs them. Lesson version and completion schema should be independent of the app's build version.

The first contextual help targets:

| Entry point | Short card | Full lesson |
| --- | --- | --- |
| CPU % help | “100% means one logical CPU's worth of time across the sample interval. A process can exceed 100%.” | `cpu` |
| Resident Memory help | “RSS is resident memory reported for this process. Shared pages mean row totals can double-count physical memory.” | `memory` |
| PID / process details help | “A PID identifies a process now; it can be reused after exit. The app also checks start identity.” | `processes` |
| Wired RAM help | “This graph shows wired memory divided by physical RAM. It does not measure memory pressure.” | `memory` |
| Pause / sample age help | “Pause stops measurement. Your programs keep running.” | `cpu` |
| Workspace association help | “This link follows visible process ancestry. Detached and remote work may have no reliable pane association.” | `processes` |

Make help reachable by keyboard and controller; do not rely on hover. A **Use current example** action can copy the selected snapshot's displayed values into an ephemeral lesson card labeled **Live sample, captured at …**. Once captured it becomes a fixed observation, with its age visible. Never silently replace the example with a new process when a PID is reused.

Keep reading separate from assessment: answers may be revealed immediately, completion is optional, and an unknown metric does not block progress. Initial progress can remain in memory. A later SQLite table should store `lesson_id`, `content_version`, completion, and reader position, with a reset option. Do not attach process paths or history to progress.

## The explorable computer

Build a small 3D teaching scene inside the native app. The camera can fly over CPU, RAM, storage, and network stations, with a persistent **Educational model** label. It is a simplified map of concepts, not a reconstruction of the user's hardware and not a virtual machine that boots software. Real counters may annotate the map, but they do not turn the drawing into a physical simulation.

| Station | Concept to teach | Honest live annotation now | Representational limit |
| --- | --- | --- | --- |
| CPU | Instructions execute over time; threads compete for execution resources | Machine CPU %, sampling time, selected process CPU % if available | No live per-core activity is collected. Decorative core shapes must not imply measured utilization or actual core count |
| RAM | Working data has virtual addresses and may occupy shared physical pages | Physical capacity, wired RAM, selected process RSS | Do not draw RSS as an exclusive physical location or add categories into an unvalidated “used” total |
| Storage | Persistent data and requests to read/write it | None in the initial collector | Label **Conceptual: disk metrics not collected**; no animated bytes/s or invented disk activity |
| Network | Programs exchange data and may wait for replies | None in the initial collector | Label **Conceptual: network metrics not collected**; no representation of intercepted packets or real destinations |

A useful first visit lasts one minute: select CPU, see its label and matching lesson; move to RAM, compare its annotation; notice storage and network are conceptual. An illustrated path between stations can teach relationships, but moving particles must be marked **Illustration** or **Simulation**. Camera movement alone is sufficient for the first version; resource-driven particles are not required.

Later add a deterministic **Example computer** mode with a toy workload. The learner steps a thread from ready to running to waiting and watches fictional counters change. Keep **Live Mac** and **Example computer** visibly distinct. A simulated scheduler teaches one specified policy; it is not a claim about macOS's exact scheduler.

## Controller ownership and flight

Route events through an explicit focused surface: terminal, monitor, lesson, or computer. The computer consumes its controller events before terminal mappings. In particular, Circle must never become Ctrl-C, Triangle must never become Enter, and shoulder movement must never navigate shell history while the computer owns input.

The existing `gamepad.rs` is the device adapter. The workspace owns routing; the world consumes normalized input without calling the terminal encoder. The adapter now emits held deflections and a neutral transition on release, with a regression test preventing idle event flooding. Flight integrates elapsed time and stops on neutral input. The native smoke verifies synthetic flight, neutral, reset, back, and no terminal input leakage; physical-controller verification remains pending.

Initial mapping agreed for the implementation:

| Controller input | Computer surface action | Accessible equivalent |
| --- | --- | --- |
| Left stick | Move forward/backward and strafe | W/A/S/D or visible movement controls |
| Right stick | Look around | Arrow keys or guided station buttons |
| L1 / R1 | Descend / ascend | Q / E or labeled controls |
| Triangle | Reset camera | R and Reset view button |
| Circle | Return to the previous surface | Escape and Back button |
| Guided component buttons | Move to CPU, RAM, storage, or network station and expose its explanation | Keyboard focus and Enter; same controls in 2D |

Keep Start/Select unassigned in this first pass so the controller roadmap can define global mode conventions. Render a visible legend for the active surface. Do not assume Xbox button lettering equals the abstract PlayStation layout. Remapping and sensitivity/invert-Y belong in later controller preferences.

On focus loss, disconnect, exit, or pause, clear velocities and held buttons. On re-entry, require fresh input or a neutral state so a held stick cannot surprise the learner. Avoid mouse capture for the initial world. Clamp the camera away from extreme positions; Reset must always recover a useful view. The world and lesson are read-only and expose no process-termination action.

## Native rendering and accessibility

Prototype a handful of projected 3D meshes with GPUI's existing native rendering primitives before choosing another engine. The bounded proof is perspective projection, depth ordering, camera transforms, station selection, and text labels integrated with the native UI. If the intended scene outgrows this approach, benchmark a GPU offscreen-surface integration separately rather than introducing a second window/input lifecycle by accident.

Use a 2D component list/map with the same annotation and lesson controls as an equal entry point. Provide keyboard-only completion, readable text at larger font sizes, explicit focus indication, and labels that do not depend on color. Motion can be disabled; guided station selection can jump instead of animate. No flashing CPU indicator or forced camera tour. Stop animation when the world is hidden or inactive. Do not require a controller to finish a course module.

Screen-reader support must be verified with the native platform; native drawing alone is not evidence of accessibility. The 2D path should expose descriptive text and actions even when the 3D canvas itself is not meaningful to assistive technology.

## Bounded milestones

1. **Readable first module.** Embed the three lessons, show an index and Back control, preserve monitor state, and keep keyboard/IME/controller input away from the PTY. Exit: lessons work offline at the minimum window size; focus returns correctly; all three observational exercises can be completed without spawning work.
2. **Contextual teaching.** Add metric help cards and deterministic fictional examples; preserve missing and warming-up states; expose lesson version. Exit: cards and full lessons agree on units; missing data has a useful explanation; completion never depends on a particular live value.
3. **Flyable teaching model.** CPU/RAM annotations use the existing snapshot; storage/network are conceptual; ship reset, component jumps, a legend, and 2D access. Exit: synthetic input tests cover neutral/focus/disconnect behavior; native GUI checks confirm visible geometry and legible labels; actual controller verification checks motion and zero terminal leakage.
4. **Saved learning and richer lessons.** Persist minimal local progress; write scheduling, families, and virtual-memory lessons; add a stepped example computer. Exit: examples are deterministic, resettable, and visibly fictional; progress reset does not touch terminal or prompt data.
5. **Validated advanced overlays.** Add disk/network annotations only after the monitor's corresponding collector contracts ship; add throughput/latency lessons. Exit: sources, units, counter resets, sample timing, and permission failures are documented; no illustration masquerades as observed data.

Each milestone includes reduced-motion and keyboard review. Measure rendering overhead against the monitor alone on the development Mac, then verify Apple Silicon separately when hardware is available. The monitor should not create a background render loop just because the course was opened once. Report measured performance and hardware coverage rather than claiming a universal frame-rate guarantee.

## First implementation checks

- Course open/close preserves the selected process identity, query, scope, and terminal shell PID.
- Circle, Triangle, shoulders, and movement while in the world produce no PTY bytes.
- Neutral, disconnect, focus loss, and returning to the world cannot leave motion latched.
- Missing CPU/RSS data and a dead selected process remain missing; annotations do not keep presenting old values as current.
- Hidden-world rendering stops; course and world share one demand-driven sampler.
- 640×420, light/dark themes, larger text, keyboard-only, reduced motion, and 2D navigation remain usable.
- A learner can explain why 250% process CPU, shared RSS, and unknown disk throughput are represented differently.

Related source: [workspace input routing](../../app/src/workspace_view.rs), [controller adapter](../../app/src/gamepad.rs), [monitor data model](../../app/src/activity/model.rs). Related plans: [Activity Monitor](../../daily-growth/roadmaps/activity-monitor-roadmap.md) and [controller roadmap](../../daily-growth/roadmaps/ps2-terminal-roadmap.md). Some historical controller notes refer to older architecture; the source currently owns polling at the workspace and already blocks terminal gamepad forwarding while Activity Monitor is visible.
