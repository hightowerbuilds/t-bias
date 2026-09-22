# Main-app GPUI Kit migration — 2026-09-21

## Delivered

The actual t-bias app now uses pinned GPUI Kit 0.6.6 and GPUI pre 0.3.6. Prompts use Kit Input/Textarea; shared buttons and Activity search use the same controls. Activity uses a virtualized Kit DataTable with process-start identity selection and session-only column widths. Settings provides validated drafts, Apply/Discard, Reload saved, and Open Configuration. Applied settings take effect after restart. Existing PTY/session ownership, SQLite schemas, prompt queue, monitor preferences, and controller profile remain in place.

The renderer is Kit's Metal path; wgpu is pinned to 29.0.4 to satisfy the combined dependency graph. Packaged minimum macOS is 15. Custom terminal cell rendering and the controller renderer remain separate from styled controls. No JavaScript/webview runtime is in the Mac target dependency graph.

## Validation

- 80 Rust tests passed; formatting and locked debug build passed.
- `./scripts/check-native.sh --gui`: terminal, copy, splits, tabs, zoom, prompt focus, Vim/less/tmux, Markdown, process lifecycle, Activity and all seven navigation destinations passed.
- `./scripts/check-native.sh --controller`: Metal GPU/readback and controller mapping, frame capture, input isolation and persistence checks passed.
- `./scripts/check-native.sh --kit`: mounted prompt editing, Unicode, draft survival, save/queue/Send without Enter, PTY isolation, long-text scrolling, settings Apply/Discard/conflict/validation, compact layout and shell survival passed.
- The Kit check exercises 10,000 synthetic process rows, bounded rendered rows, selection across sorting, viewport stability, reused PID rejection and hidden columns.
- `./scripts/package-native.sh`: optimized app bundle and local ad-hoc signature succeeded. The packaged app also passed `--kit-smoke`.
- `--check-data` on a private copy of existing data passed: one tab, zero stored prompts/queue entries; monitor preferences, config and controller preserved. Prompt workflows were separately exercised with synthetic fixtures.
- Isolated native screenshots reviewed for dark Prompts, compact light Settings and Dracula Activity. `scripts/capture-native.py` reproduces captures without opening personal data.

Validated on this Intel Mac running macOS 26.6.2 with a 1× display. Real OS IME candidate windows, physical 2× transitions, accessibility-tree inspection, Apple Silicon/minimum-OS testing, sustained scrolling benchmarks and Developer ID notarization remain open release checks. Simulated composition coverage from the standalone probe does not establish real IME support.

## Idle observation

Same fresh terminal-window scenario, debug binaries, five-second settle and ten one-second `ps` samples: baseline median 2.55% CPU / 85.8 MiB RSS; Kit median 3.55% CPU / 93.9 MiB RSS. This short sequential observation shows roughly 8.1 MiB additional resident memory; it is not a sustained performance or scrolling benchmark. Reproduce with `experiments/gpui-kit/measure_idle.py` and each binary.

## Development and rollback

Run `./dev` from the repository root to build and open the main app. `./dev build` builds without replacing a running window. Command-Comma opens Settings; saved changes require restart.

`legacy/pre-kit-2026-09-21.tar.gz` preserves the full pre-migration source snapshot, including work that was uncommitted when migration began. Its adjacent SHA-256 file verifies the archive. Extract it into a separate directory for inspection or rollback; do not overwrite ongoing work. The existing distributed bundle was not replaced during validation. This checkpoint preceded publication; see the [daily summary](2026-09-21.md) for the subsequent main-branch delivery.
