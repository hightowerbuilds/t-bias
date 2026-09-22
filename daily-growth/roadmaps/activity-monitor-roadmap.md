# t-bias — Native Activity Monitor roadmap

**Updated 2026-09-20. The first read-only implementation is available in source following the user's “let's get started.” The full roadmap is not complete.**

Build a native view that answers “what is using this Mac's resources?” and “which terminal job is responsible?” without leaving t-bias. Take macOS Activity Monitor's searchable process table, sortable resource columns, process detail, and system overview as the starting point. Apple documents those interactions and process scopes in its [Activity Monitor guide](https://support.apple.com/guide/activity-monitor/view-information-about-processes-actmntr1001/mac).

The [native GPUI roadmap](gpui-rebuild-roadmap.md) remains the foundation, including its outstanding notarization follow-up. The user has now started this workstream; the separate [controller roadmap](ps2-terminal-roadmap.md) is unchanged. Unchecked items below remain proposed work or incomplete validation.

## First implementation checkpoint

- Implemented in `app/src/activity/`: read-only CPU/RSS process table, search/sort, keyboard selection and copy, details, All/My/Workspace/Active Pane scopes, and Show in Terminal.
- One demand-created worker collects off the GPUI thread and publishes through one replaceable snapshot plus a bounded wake channel. It sleeps without periodic sampling when closed, paused, or inactive. CPU baselines reset on resume; history is limited to 60 system samples.
- Native View menu, toolbar entry, configurable ⌘⇧A shortcut, monitor-owned Command-W, and keyboard/controller isolation preserve existing PTY sessions. Narrow/short windows use a compact summary and horizontally scrollable table.
- Backend decision: use the existing `libc = 0.2.186` bindings for this macOS iteration. `sysinfo`'s documented API and [macOS implementation](https://github.com/GuillaumeGomez/sysinfo/blob/master/src/unix/apple/macos/process.rs) were reviewed as an alternative; a new cross-platform dependency does not remove the underlying macOS API constraints. No dependency or toolchain change was needed. Apple Silicon and minimum-OS validation remain outstanding.
- CPU contract: `PROC_PIDTASKALLINFO` supplies process counters in Mach absolute-time units; convert with `mach_timebase_info` before dividing by per-process monotonic elapsed time. Apple's [`fill_taskprocinfo`](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c) uses Mach task times. One logical core is 100%; resets, first samples, and gaps over 30 seconds have no percentage. `HOST_CPU_LOAD_INFO` supplies the separate machine-wide CPU ratio.
- Memory contract: process RSS is `pti_resident_size` in bytes. Physical capacity is `hw.memsize`; active, wired, compressed, and free page counts come from `HOST_VM_INFO64` with the actual page size. The graph is explicitly wired RAM / physical RAM. There is no invented pressure, footprint, or Energy Impact metric.
- Access behavior: retry bounded PID enumeration; fall back to BSD metadata if task metrics are denied. Unknown metrics remain absent. Paths are requested for selected processes and identity-checked; environments and argument lists are not collected. No privilege prompt or helper is added.
- Validation: 65 unit tests pass; debug and optimized builds pass. The initial native GUI smoke passed real collection, workspace filtering, terminal-action isolation, and returning to the same shell. Final compact-layout/light-theme visual verification and the expanded pause/resume and child-job smoke are pending after the additional GUI launch was declined. The distributed signed bundle has not been replaced.
- Initial live probe on the Intel Mac: 514 processes, 288 inaccessible/partial records; controlled CPU 99.5%, touched 64 MiB allocation visible in RSS, collection 5.77 ms. These are point measurements, not the roadmap's full performance certification.
- At this checkpoint, saved table preferences and expandable hierarchy/subtree totals remained; these are implemented in the following checkpoint. Richer detail history, broader process-tree fixtures, a 30-minute measured soak, and Apple Silicon/minimum-OS coverage remain outstanding. Phase 4 actions and Phase 5 metrics remain unimplemented.

## Learning and process-tree checkpoint — 2026-09-20

- Added expandable process families with separate direct and subtree CPU/RSS totals, explicit unavailable-member counts, shared-page overlap labeling, and bounded traversal of deep/cyclic trees.
- Scope, sort, list/tree mode, and visible columns now persist in a versioned SQLite settings record separate from terminal workspace rows. Searches, selected identities, snapshots, and expansion state remain ephemeral. Corrupt or unsupported settings are preserved and reported.
- A delegated course author produced the ten-module [Inside Your Computer](../../docs/learning/README.md) outline and three full starter lessons. Processes, CPU/time, and memory are now embedded in the native Learn reader and linked from corresponding table headers.
- Computer opens an initial native perspective-projected 3D teaching model, with controller and keyboard flight, reset, guided station jumps, CPU/RAM lesson links, and a 2D alternative. CPU/RAM use existing samples; storage/network are explicitly conceptual. It does not run a guest OS or reconstruct physical hardware.
- Input belongs to the active monitor/reader/world surface. The controller adapter now emits a neutral stick transition; camera motion is cleared on focus loss, disconnect, hide, and reset. The animation timer runs only while moving.
- Validation: 72 unit tests and optimized build pass. The expanded native GUI smoke passes live collection, child-job scope, terminal restoration, embedded lessons, 3D rendering, synthetic controller flight/neutral/reset/back, persisted settings, and no PTY input leakage. Physical-controller flight, comprehensive accessibility/light-theme/small-window coverage, packaged-app validation, and the existing platform/performance checks remain pending. The distributed signed bundle has not been replaced.
- Next learning work: author the remaining seven lessons, add optional progress and contextual snapshot exercises, then build explicitly fictional scheduler/virtual-memory simulations. See the [integration plan](../../docs/learning/integration-plan.md).

## Proposed first release

A read-only **Activity Monitor utility panel** inside the existing window, with CPU and memory summaries above a virtualized process table. Open it through View → Activity Monitor and a configurable shortcut; Escape closes it and restores the previous focus. A pane entry point opens the same panel filtered to that shell's process tree.

| First release | Later, separately gated |
| --- | --- |
| Name, PID, owner, CPU %, resident memory, threads, state | Disk and network throughput; additional macOS memory metrics |
| Search, column sorting, process detail, pause/resume | Terminate and Force Quit after action-safety validation |
| All visible processes, My Processes, This Workspace, Active Pane | Detachable window, monitor panes/tabs, persistent recording |
| System CPU and memory summaries with short history | Energy, GPU, temperature, fan data, alerts |
| Show in Terminal for confidently associated processes | Remote hosts, containers, automatic remediation |

“All processes” means the inventory the OS lets us enumerate. An unavailable metric displays an em dash and a reason when known; it never becomes a misleading zero. The panel must remain useful when some processes disappear or deny access.

## Existing foundation and integration points

These are observations from the current Rust code, not features of the proposed monitor:

- `app/src/workspace_view.rs` owns cached terminal entities keyed by `(TabId, PaneId)`. Hidden tabs keep their shells alive. Tabs and split leaves currently imply terminal sessions, so adding a fake monitor terminal would break those assumptions.
- `app/src/terminal.rs::Terminal::pid()` exposes each live shell PID. The module already uses macOS `proc_pidinfo` for cwd, and terminal shutdown owns PTY cleanup and child reaping.
- `app/src/db.rs::ShellRecord` stores historical shell lifecycle data. Its timestamps and PIDs are not a current OS process inventory or a reliable process identity after restart.
- The prompt panel supplies a native utility-view precedent; `text_field.rs` supplies search-field editing. `menus.rs`, `config.rs`, and `WorkspaceView::action` connect menus and shortcuts.
- Keyboard actions and gamepad events currently route toward the active terminal. Opening a monitor requires explicit focus routing so search, selection, confirmation, and close actions do not also reach a shell.

Proposed modules: `activity/model.rs` for snapshots, identity, deltas, sorting and filters; `activity/collector.rs` for sampling ownership; `activity/macos.rs` for platform access; `activity/view.rs` for GPUI; and, only in the action phase, `activity/actions.rs` for validated process commands. Keep the data model independent of GPUI and the backend replaceable.

## Phase 0 — Prove the data sources and fix the metric contract

- [ ] Run a small collector spike on the current Intel/AMD Mac and an Apple Silicon Mac when available. Test the packaged, hardened-runtime app without elevated privileges, including other-user and protected processes.
- [ ] Compare a pinned `sysinfo` release against a thin macOS backend for the required fields. Verify toolchain/MSRV compatibility, license, dependency size, supported OS versions, and actual macOS behavior before choosing or adding dependencies. `sysinfo` is a candidate, not an existing dependency.
- [ ] Record a capability table: API/backend, counter unit, sampling requirements, supported OS range, permission failures, and fallback for every displayed metric. Validate against the installed SDK; an upstream header alone does not establish deployability.
- [ ] Evaluate `proc_listallpids`, `proc_pidinfo`, and `proc_pid_rusage` for inventory and per-process data. Apple's [libproc header](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h) declares these interfaces but explicitly describes the header's interfaces as private and subject to change. Document the compatibility/distribution implications, including any future App Store ambitions, before adopting them.
- [ ] Evaluate Mach host CPU/VM counters for system totals; confirm allocation cleanup, units, and supported calls in the installed SDK. Avoid launching `ps`, `top`, or other subprocesses on each production refresh.
- [ ] Establish process identity as PID plus OS process-start identity. Apple's [process-info structures](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h) include parent PID, user IDs, start-time fields, thread counts, CPU-time counters, and resident size. Preserve original precision; the SQLite shell start timestamp is unsuitable.
- [ ] Define per-process CPU as `100 × delta(user + system CPU time) / monotonic elapsed time`, with 100% representing one logical CPU and multicore processes allowed above 100%. Define overall CPU as a separate machine-normalized percentage. Verify native counter conversion; first samples, resets, and invalid intervals are “warming up.” If using `sysinfo`, follow its refresh contract instead of taking deltas of an already calculated percentage; its [Process documentation](https://docs.rs/sysinfo/latest/sysinfo/struct.Process.html) describes CPU refresh and memory semantics.
- [x] Label the first process memory column **Resident Memory (RSS)**. Keep physical footprint, virtual size, compressed memory, and machine memory pressure distinct. Do not sum RSS and label it system memory used; shared pages make that misleading. Apple's [memory guide](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac) describes pressure as more than a free-RAM percentage.

**Exit:** a written backend decision and metric contract, repeatable samples from owned test processes, and an honest supported/unavailable matrix. CPU and RSS may ship even if advanced metrics remain unresolved.

## Phase 1 — Background collector and bounded history

- [x] One sampler service per application, created on demand. Collect, calculate deltas, resolve cached owner names, associate trees, and prepare ordered row IDs off the GPUI foreground thread. No OS enumeration, blocking lookup, or SQLite write in `render()`.
- [x] Publish immutable snapshots with a monotonic sample timestamp, sequence number, completeness/errors, system totals, and per-process records. Use a latest-value slot or bounded channel that coalesces snapshots; a slow UI must not accumulate an unbounded backlog. Notify GPUI once per accepted snapshot.
- [x] Proposed defaults: refresh every 2 seconds while visible; allow 1, 2, or 5 seconds plus Pause. Stop sampling while closed and suspend it when the app is inactive unless the user explicitly enables background monitoring later. Resume with a fresh baseline after sleep or long gaps.
- [ ] Keep 60 system-summary samples in a ring buffer. Retain process history only for selected/pinned detail views with a fixed limit; do not retain a full process table for every time point.
- [ ] Handle exit during enumeration, partial reads, counter decreases, identity changes, permission denial, and unknown state. Expire identity/cache entries and invalidate details requests when selection changes. Show sample age and paused/stale states.
- [x] Stop and join the worker cleanly on shutdown, using an interruptible wait. Closing the monitor does not touch the PTY/session lifecycle; reopening does not create duplicate workers.

**Exit:** deterministic model tests for deltas, bounded buffers and lifecycle; no foreground collector calls; no worker or memory growth across repeated open/close cycles.

## Phase 2 — Read-only native MVP

- [x] Add an app-owned utility view without changing terminal split-tree persistence. Provide enough width for a table; use horizontal scrolling or hide optional columns at the existing 640×420 minimum window size.
- [x] Add menu/action/config wiring and a shortcut after checking conflicts. Scope Command-W to close the monitor while it owns focus; Escape dismisses detail/search/panel in a defined order. Preserve the previous terminal focus.
- [x] Route keyboard, IME, clipboard, and controller input by focused surface. Monitor search must not type into the active PTY; controller buttons must not send Ctrl-C or other terminal actions through the panel. Controller-specific monitor navigation remains later work.
- [x] Render CPU and memory summary values and compact history charts, plus process count and last-sample age. State the system-memory formula in help text; omit pressure until its semantics are verified.
- [x] Build a virtualized table with the MVP columns, reversible header sorting, stable tie-breaks, case-insensitive name/PID search, row selection, keyboard navigation, and visible focus. Keep selection keyed by process identity rather than row position as values reorder.
- [x] Add detail for name, PID/parent, owner, start time, CPU/RSS, and available executable path. Fetch expensive detail only when requested. Avoid collecting environment variables; command arguments, if added, are opt-in detail and excluded from diagnostics by default.
- [ ] Provide empty, loading, warming-up, partial-access, paused, stale, and exited-selection states. Sorting and selection remain usable while updates arrive; confirmation dialogs later must freeze their target identity.

**Exit:** usable CPU/memory monitor in the real GPUI window with keyboard and mouse; terminal typing, TUIs, prompts, tabs, and split resizing still work while it samples.

## Phase 3 — Terminal and workspace awareness

- [x] Have `WorkspaceView` publish a read-only registry of current shell identities and `(tab_id, pane_id)` associations. The sampler receives copies, never GPUI entities or terminal locks.
- [x] Build descendant relationships from each OS snapshot. Add This Workspace and Active Pane scopes alongside My Processes and All Processes; changing active panes updates the filter without restarting sampling.
- [ ] Display owning tab/pane for confident matches and add **Show in Terminal**. Revalidate that the same session still exists before focusing it; an old pane ID must not point to a replacement shell.
- [x] Support an expandable hierarchy with clearly separate direct and subtree CPU totals. Deduplicate identities in aggregates; label summed resident memory as an estimate containing shared-page overlap.
- [ ] Test pipelines, foreground/background jobs, nested shells, `exec`, detached jobs, and tmux. Parent-child snapshots are an association heuristic: reparented daemons and shared tmux servers can lose or ambiguously share ownership. Show Unknown/Shared rather than invent a one-to-one owner.
- [x] Label this as **local** monitoring. SSH clients, Docker clients/VMs, and remote/container workloads are not their remote process inventory. Do not imply otherwise from a terminal command name.

**Exit:** launching a CPU-consuming job from a pane makes it discoverable in that pane's scope; switching tabs and closing shells updates associations. The monitor itself does not change session or job lifecycles. Phases 0–3 define the proposed read-only release.

## Phase 4 — Explicit process actions

Ship this separately after the read-only view and process identity checks are proven.

- [ ] Offer **Terminate (SIGTERM)** and a separate **Force Quit (SIGKILL)** for eligible same-user processes. Describe termination as a signal request, not a promise that a GUI app will save documents or display its normal Quit dialog. Never escalate automatically from TERM to KILL.
- [ ] Confirmation shows captured process name, PID, start identity, owner, and affected pane when known. Force Quit explains unsaved work can be lost. Block t-bias itself and PID 0/1; never interpret UI input as a negative PID or process-group selector.
- [ ] Before sending, refresh identity and ownership; refuse an exited, changed, unavailable, or mismatched target. Use a typed single-process action, with errors surfaced from the OS. The [Darwin kill manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html) documents permission errors, missing targets, and the special meanings of nonpositive PIDs.
- [ ] Document the remaining race between identity recheck and PID-based signaling. Do not claim PID/start-time checks make `kill` atomic; evaluate a supported stronger targeting mechanism during implementation if available. Keep unavailable/uncertain targets read-only.
- [ ] Show “signal sent,” “still running,” “exited,” or the actual failure; a successful syscall is not proof of exit. Let existing shell-exit handling collapse terminal panes normally.
- [ ] Keep terminate-tree, process-group signals, privileged helpers, automatic cleanup, renice, and stop/resume outside this release. No request for sudo, Accessibility, Full Disk Access, or debugger/task-port entitlements as a blanket solution to missing metrics. Test actual restrictions and document feature-specific needs if any emerge.

**Exit:** tests use processes owned by the test harness; TERM-handled, TERM-ignored, already-exited, stale-identity, and permission-denied cases behave correctly. Cancel and focus loss cannot send a signal or an input byte to the terminal.

## Phase 5 — Advanced metrics, each with a feasibility gate

| Feature | Investigation and acceptance gate |
| --- | --- |
| Physical footprint and richer memory | Evaluate supported `proc_pid_rusage` flavors; keep RSS and footprint separately labeled. Apple's [resource structures](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h) include footprint and disk counters, but runtime access and semantics need validation. |
| Disk | First prove per-process cumulative read/write counters and derive rates over measured intervals. Verify cache behavior, resets and permissions; do not equate their sum with physical device throughput. Device-level graphs are separate work. |
| Network | Start with interface-level received/sent bytes if supported. Handle interface churn, loopback, VPNs and potential double counting. Per-process attribution needs its own supported-source/permission investigation; socket lists are not bandwidth counters. |
| Memory pressure | Investigate OS pressure signals and VM counters. The [Dispatch memory-pressure API](https://developer.apple.com/documentation/dispatch/dispatchsourcememorypressure) is a candidate signal, not proof of parity with Activity Monitor's chart. Ship only with a clear definition. |
| Energy and battery | Battery/AC status can be evaluated separately. Apple's [archived energy diagnostics guide](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/MonitoringEnergyUsage.html) provides background, not a public Energy Impact formula or API guarantee. Do not relabel CPU usage as Energy Impact or watts. |
| GPU, thermals, fans | Research separately for Intel and Apple Silicon; avoid assuming a portable supported API. Leave unavailable until permission, compatibility, overhead and packaging are demonstrated. |

Long-term history/export, alert thresholds, per-tab resource badges, detachable windows, and remote adapters are optional later proposals. They should not delay the read-only MVP or silently turn this into a background monitoring service.

## Settings, persistence and privacy

- [x] Add validated `[activity_monitor]` configuration with serde defaults so old config files load. Store sampling preferences there; document whether changes require restart in keeping with current configuration behavior.
- [x] Persist sort direction, visible columns, and last chosen scope through a small versioned UI-settings record. Keep monitor state separate from terminal pane rows. Ephemeral text searches, selected PIDs, process snapshots, and graphs are not restored as live processes.
- [x] Add no telemetry or automatic process-history writes. Retain bounded samples in memory only; persistent recording/export requires a separate explicit product decision.
- [ ] Log collector failures and timing summaries with rate limits, not every process name, executable path, argument list, or sample. Tests use `TBIAS_DATA_DIR` to isolate settings and leave existing shell/prompt data intact.

## Verification and proposed performance budget

These are targets to measure, not claims about performance already achieved.

- [ ] Pure tests: identity replacement/PID reuse, CPU math and time conversion, startup/sleep/reset baselines, sorting ties and unknown values, filtering, malformed trees/cycles, attribution ambiguity, bounded history, and stale detail replies.
- [ ] Controlled integration fixtures: one-core and multicore CPU work, a touched-memory allocation, process churn, parent exit/reparenting, same-user termination, and deliberate access failures. Compare with Activity Monitor/`ps` over matched intervals and definitions; investigate differences rather than assert exact instantaneous parity.
- [ ] UI fixtures: 1,000 and 10,000 synthetic process rows, rapid sorting/search, narrow windows, light/dark themes, Unicode names, keyboard/IME, selection during resort, and paused/stale display. Verify the viewport renders only visible rows and overscan.
- [ ] At 2-second refresh on the Intel development Mac, target less than 1% of one logical CPU added by steady monitoring, under 50 MB incremental steady memory at 1,000 processes, and under 4 ms p95 foreground snapshot adoption. Profile realistic loads; revise targets with recorded evidence if needed.
- [ ] A 30-minute visible run and repeated open/close exercise show bounded memory, no accumulating workers/queued snapshots, and no measurable regression in terminal input latency or TUI responsiveness. Closed monitoring has no periodic sampling wakeups.
- [ ] Run `./scripts/check-native.sh`, extend isolated native GUI smoke for open/filter/focus/close and owned process fixtures, and repeat with the signed packaged app. Test Intel and Apple Silicon and the supported macOS minimum/current releases as hardware permits; explicitly record gaps.

## Dependencies and decisions before implementation

**Order:** Phase 0 → Phase 1 → Phase 2 → Phase 3 → read-only release review. Phase 4 is an independent feature decision after identity and UX validation. Each Phase 5 metric depends on its own capability proof. Rebase integration work on whatever controller changes exist when implementation starts; neither project should fork terminal input or lifecycle ownership.

Proposed defaults make the draft actionable; these product choices remain open:

1. **Placement:** use a utility panel initially; decide later whether a detachable window or a true new pane type earns a workspace-model migration.
2. **Landing scope:** default to All Processes for a familiar Mac overview, with a clear This Workspace filter and pane-specific entry point. A terminal-focused default is an equally reasonable alternative.
3. **Actions:** deliver read-only first; decide whether same-user Terminate/Force Quit belongs in the following release.
4. **Background behavior:** pause when hidden/inactive; continuous recording and badges would require a new sampling/power policy.
5. **Distribution/backend:** select the dependency/API strategy after the spike and clarify whether future App Store distribution constrains it. Existing Developer ID delivery does not settle API longevity.
6. **Sequencing:** the user started the first Activity Monitor implementation after reviewing the draft. Controller work remains separate; later actions/advanced metrics need their own implementation milestone.

**Definition of done for the first release:** the user can find a resource-heavy local process, inspect honestly labeled CPU/memory data, identify its terminal when possible, and return to the running session without input leakage or sampling stalls. Unsupported metrics are clearly unavailable, persisted terminal data remains compatible, and the packaged application passes the relevant checks above.
