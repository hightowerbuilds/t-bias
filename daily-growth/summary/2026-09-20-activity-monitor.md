# Activity Monitor first implementation — 2026-09-20

The user started the Activity Monitor roadmap after reviewing the sub-agent's draft. Controller feature work remains separate.

Added a native read-only process monitor in `app/src/activity/`: background macOS collection, Mach-unit CPU deltas, explicit RSS and wired-memory metrics, bounded snapshots/history, process filtering/sorting, virtualized rows, details, and shell ancestry. PID/start identity and per-session entity tokens keep selection and terminal links separate from reused process/pane IDs. Missing metrics remain unavailable rather than zero.

The monitor opens from View, the Activity toolbar button, or Command-Shift-A. Command-W closes it and preserves shells; keyboard and controller actions do not reach the hidden terminal. Search supports native composition and clipboard, the collector sleeps while hidden/paused/inactive, and restart configuration supports 1/2/5-second intervals. Narrow windows switch to compact summaries. Added optional theme support to the shared text field for the light-theme search box.

Validation: 65 tests pass, including CPU units/resets, ancestry cycles/reuse, 10,000-row sorting/filtering, nested terminal scopes, configuration compatibility, and idle worker shutdown. Debug and optimized builds pass. An initial live probe enumerated 514 processes (288 unavailable/partial), measured controlled CPU at 99.5%, detected a touched 64 MiB allocation, and collected in 5.77 ms. The initial real-window smoke passed collection, workspace filtering, terminal-action isolation, and return to the same shell. Actual native search/selection and the original dark layout were inspected. The small-window check found excessive summary height, which was corrected in source.

The subsequent GUI launch was declined. Final compact/light visual checks and expanded live pause/resume/child-job smoke remain pending; no attempt was made to bypass that decision. `scripts/check-native.sh --activity` now provides those collector and GUI checks; `--gui` includes the original terminal smoke as well. No new signed bundle was distributed.

Further roadmap work includes saved table preferences, expandable trees/subtree totals, detail history, long-duration overhead measurement, and Apple Silicon/minimum-macOS coverage. Process termination, disk/network/energy metrics, and controller features are not implemented by this checkpoint. Existing unrelated summary changes are preserved.
