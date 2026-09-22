# GPUI Kit: renderer compatibility checkpoint

## Decision

Continue evaluating **Kit 0.6.6 / GPUI pre 0.3.6** as the migration candidate. The isolated native probe displays text, Kit controls, and a reduced terminal-cell canvas on the development Mac. The previous GPUI 0.2.2 Metal missing-glyph failure did **not** reproduce in this probe. Development and optimized packaged input smoke checks pass.

This is promising Phase 0 evidence, not completion of the application migration or every renderer acceptance check. Keep the main application on GPUI 0.2.2/Blade until the remaining checks below are resolved. The prompt panel is still the first planned migrated surface after the bootstrap/API port.

## Reproducible experiment

Source and commands: [experiments/gpui-kit](../../experiments/gpui-kit/README.md). It has a separate manifest, exact Kit pin, Rust toolchain, lockfile, build directory, native input smoke, packaging script, and idle-observation utility. It embeds its icons and uses no application database, PTY, Kit shell, JavaScript VM, or webview. Target-specific dependency inspection confirms one GPUI family.

| Item | Recorded value |
| --- | --- |
| Kit / Base / Component / Assets | 0.6.6 resolved in the probe lockfile |
| Kit registry source revision | `9765ae2c9a5eccfa13891248a445991e6f6a09d8` |
| GPUI pre / platform / macOS / Apple | 0.3.6 |
| GPUI snapshot source revision | Zed `bcf6582ce3500df93a8a39366640173e6786cea6` |
| macOS renderer | `gpui-pre-apple` Metal, `runtime_shaders` enabled through Kit/platform |
| Blade support | No `macos-blade` feature in this family |
| Licenses | Kit and GPUI declare Apache-2.0; transitive release review remains separate |
| Documented minimum OS | macOS 15; declared in the **probe** bundle only |
| Installed OS | macOS 26.6.2, build 25G83, x86_64 |
| GPUs present | Intel UHD Graphics 630 and AMD Radeon Pro 5500M, 8 GB |
| SDK / developer directory | SDK 26.5, `/Library/Developer/CommandLineTools` |
| Rust / Cargo | 1.95.0 / 1.95.0 |
| Full Xcode Metal compiler | `xcrun --find metal` unavailable; runtime shader build succeeds without it |
| Display observed | 1×; selected Metal device was not instrumented separately |

Published [Kit 0.6.6](https://crates.io/crates/gpui-kit/0.6.6) and its installed normalized manifests are the implementation references, rather than the moving website version selector or main branch. The [installation guide](https://gpui-kit.com/docs/installation/) supplies the documented OS requirement. The old app's declared macOS minimum is unchanged.

## Current-app baseline and preservation

- `./scripts/check-native.sh`: formatting, **79 tests**, and build pass.
- Isolated `--smoke-test`: `NATIVE_SMOKE_OK`, covering shell input, copy, splits, zoom, tabs, session survival, SQLite restore, prompts, explorer flip, close, Vim, less, tmux, Markdown, and shell exit.
- The main `app/Cargo.toml` and lockfile were not migrated. Lockfile SHA256 before and after: `74ba712015e780ffa4f19f309d5dbc29023b51deaa35cbed795c968d6dafd3cb`.
- The working source—including uncommitted Controller/Activity work—was archived at `/tmp/tbias-pre-kit-fr3r6euw/working-source.tar.gz`. SHA256: `5627904278afbb11810ff4b9d48f6e146cd99758e4169cc127a538e44082da46`. That directory also holds the working debug executable and matching lockfile. This local temporary checkpoint is not a published release or durable backup.

## Probe evidence

- **Development build:** `cargo build --locked --offline -j 6` succeeds. `./check.sh` checks formatting, builds, and guards against a legacy GPUI runtime or optional JS/webview dependency in the Mac target graph.
- **Visual inspection:** styled text, button/icon, Input, Textarea, and the custom canvas are visible in the same window. The Alacritty fixture displays ASCII, CJK, combining marks, emoji, colored/bold/underlined text, selection rectangles, and cursor. Screenshot: `experiments/gpui-kit/evidence/kit-debug.png` (local ignored evidence).
- **Input smoke:** `KIT_INPUT_SMOKE_OK` from the debug executable and the optimized executable inside the signed bundle. Checks use mounted controls and dispatch native clipboard actions; Unicode, marked-text commit, field focus isolation, copy/paste, undo/redo, multiline editing, 640×420 resize, scroll offset, and theme changes pass. The final probe restores the clipboard after successful smoke completion.
- **Release/package:** `cargo build --release --locked --offline -j 6`, plist validation, ad-hoc signing, and strict signature verification pass. The separate bundle is `experiments/gpui-kit/dist/GPUI Kit Probe.app`.
- **Packaged visual launch:** opened the bundle through Launch Services in light mode at 640×420. Header, buttons, and text inputs are readable; remaining content is scrollable below the viewport. Screenshot: `experiments/gpui-kit/evidence/kit-release-compact-light.png`. The translucent child-background flag does not establish transparent compositing through Kit's root; that remains unverified.
- **API differences found:** shaped-line painting needs `TextAlign` and optional width parameters; the window-close observer receives `(&mut App, WindowId)`; application startup uses the Kit platform factory, initialization/assets, and `Root` wrapper.

The terminal fixture deliberately exercises the app's background-quad/row-shaping strategy against the candidate API. It does not establish that the complete terminal view, PTY lifecycle, selection interactions, or all application APIs have been ported.

## Performance observations

`KIT_FIRST_PAINT` reported 1025.3 ms on the first debug launch, 380.2 ms on a subsequent debug smoke launch, and 962.9 ms on the first packaged release smoke. These are single observations from Rust `main` to the first canvas paint callback; they exclude OS process-launch overhead and do not measure screen presentation. Startup conditions were not controlled well enough to compare profiles.

The idle utility records ten one-second `ps` CPU/RSS observations after a five-second settling period. The full debug terminal and optimized, much smaller Kit probe are different workloads; use these only as initial observations, not a claimed performance improvement. Like-for-like terminal-output, scrolling, and prompt-editing comparisons remain required during integration.

| Fresh-window scenario | Median `ps` CPU | Median RSS |
| --- | ---: | ---: |
| Current full app, debug terminal | 7.8% | 87,442 KiB |
| Packaged release Kit probe | 0.3% | 80,748 KiB |

The baseline CPU samples varied from 2.7% to 13.6%; this short observation is not a stable performance budget. Raw observations are retained locally in `experiments/gpui-kit/evidence/baseline-idle.json` and `kit-release-idle.json`. An earlier baseline sample taken during compilation was excluded.

## Remaining gate / next implementation

1. Exercise real OS IME candidate selection/cancellation, pointer and keyboard-only workflows, long-prompt scrolling, transparency, and display-scale transitions. Simulated marked text is not a substitute for an OS input method test.
2. Port the existing app to the single Kit GPUI family in an isolated working-source copy, preserving this baseline. Adapt bootstrap/root access, custom painting/input APIs, close hooks, and smoke entry points; validate the actual terminal and retained session ownership.
3. Establish shared theme/focus conventions, including Dracula and terminal ANSI separation. Then migrate the complete prompt workflow to Kit Input/Textarea/Button, retaining the prompt store/queue and Send-without-Enter behavior.
4. Run copied-data continuity and the existing native/controller/navigation smoke checks on that candidate before making it the application baseline.

Apple Silicon, older supported OS versions, individual GPU paths, native accessibility, sustained scrolling/input latency, Developer ID signing/notarization, and a distributable app release are unverified. Phase 0's combined acceptance checkboxes remain open where they include these missing checks.
