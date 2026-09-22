# GPUI Kit compatibility lab

Phase 0 of the [integration roadmap](../../daily-growth/roadmaps/gpui-kit-integration-roadmap.md). This is a standalone Rust package with its own lockfile and target directory. It neither links GPUI 0.2.2 nor opens the application's database or shells.

## Run

From this directory:

```sh
./check.sh                           # format, locked build, dependency guard
./check.sh --smoke                   # native mounted-input smoke; requires a desktop
./target/debug/tbias-gpui-kit-probe   # interactive visual/input checks
./target/debug/tbias-gpui-kit-probe --light --compact --transparent
./target/debug/tbias-gpui-kit-probe --long # 300-line Unicode prompt for scrolling
./package.sh                        # local, ad-hoc-signed optimized .app
open 'dist/GPUI Kit Probe.app'
'dist/GPUI Kit Probe.app/Contents/MacOS/tbias-gpui-kit-probe' --smoke
python3 measure_idle.py target/release/tbias-gpui-kit-probe
```

The probe embeds its Kit icon assets. Build with the pinned Rust 1.95.0 toolchain and macOS Command Line Tools. Kit enables runtime Metal shaders, so the `metal` compiler from full Xcode is not required by this dependency combination. The local bundle declares macOS 15 minimum, matching Kit's documented requirement; the main application has since adopted the same minimum as part of its [Kit migration](../../daily-growth/summary/2026-09-21-kit-app-migration.md).

`--transparent` now overrides Kit Root's opaque background with transparent black and paints the probe background at 75% opacity. This corrects the stacked-background issue found in the pinned Root implementation. Desktop compositing still needs visual verification; a source fix and successful build alone do not establish it.

## What it tests

The same window contains Kit Button, Input, Textarea, styled text, and a custom Alacritty grid canvas. The canvas uses the main terminal's two-pass background-quad and shaped-row approach, with wide-character spacers, combining marks, ANSI colors, selection, and cursor painting. It is a reduced rendering fixture, not the whole terminal view or a PTY compatibility test.

`--smoke` runs against real mounted input controls and native clipboard actions. It checks Unicode, marked-text composition/commit at the input-handler boundary, focus isolation between two fields, copy/paste, undo/redo, multiline editing, resizing to 640×420, scrolling, and dark/light changes. A successful run prints `KIT_INPUT_SMOKE_OK` and restores the clipboard. It does not simulate a physical OS IME candidate window or assert screenshot pixels. Visually inspect the window even if smoke passes.

The extended smoke also dispatches pointer and Tab/Shift-Tab events through the mounted window, exercises wheel and caret scrolling inside a 300-line textarea, copies the full long selection, checks compact resizing, and cancels marked text at the input-handler boundary. Event dispatch is deferred until the current Probe update releases its entity borrow. Caught assertion failures restore the clipboard and exit nonzero. The extended smoke is **not yet verified end to end**: initial runs exposed reentrant fixture event dispatch; the final GUI rerun was declined. See the [input/rendering checkpoint](../../daily-growth/summary/2026-09-21-kit-input-rendering.md).

`KIT_DISPLAY` reports actual window scale and viewport changes. It observes the platform; it does not synthesize 2× hardware.

`KIT_FIRST_PAINT` measures time from Rust `main` to the first canvas paint callback, not OS process launch to screen presentation. `measure_idle.py` opens one fresh process, gives it a private temporary data directory, observes CPU/RSS after settling, then terminates only that process. Its `ps` samples and log are retained in the printed temporary directory. Compare like workloads before drawing performance conclusions; the simple Kit probe and a full terminal are not equivalent workloads.

Builds, bundles, and `evidence/` are ignored. Keep the source, exact manifest, and lockfile in version control. The renderer decision, observed results, and unverified checks are recorded in the [checkpoint](../../daily-growth/summary/2026-09-21-gpui-kit-probe.md).

## Manual acceptance still matters

- Click the button and edit both fields; check mouse and Tab focus, selection, and long-text scrolling.
- Compose using a real OS input method, including candidate selection and cancellation.
- Inspect dark/light, compact size, transparency, and movement between 1×/2× displays.
- Validate native accessibility and the actual terminal/PTY path during application integration.
- Repeat on Apple Silicon and the oldest supported macOS before claiming support there.

For a repeatable manual pass, use `--long --transparent`, click and Tab through the controls, wheel-scroll inside the textarea, and use Command-Up/Down to bring its first/last line and caret into view. Select/copy and edit at both ends, then repeat at compact size and in light mode. Place the window over contrasting backgrounds to inspect alpha compositing. With a Japanese input method selected, type `nihon`, open the candidate list with Space, select and commit a candidate, then compose again and cancel with Escape; verify existing committed text and the other field remain intact. Restore your previous input source afterward. Move the window between real 1× and 2× displays and check `KIT_DISPLAY`, glyphs, cursor/selection, and pointer hit targets at each scale. Record unavailable hardware separately.

## Pinned sources

- `gpui-kit`, `gpui-base`, `gpui-component`, `gpui-kit-assets`: 0.6.6 in the lockfile. Kit's registry source records revision `9765ae2c9a5eccfa13891248a445991e6f6a09d8`.
- `gpui-pre`, platform/macOS/Apple packages: 0.3.6. Published metadata identifies Zed revision `bcf6582ce3500df93a8a39366640173e6786cea6`.
- Kit and GPUI declare Apache-2.0. The complete transitive dependency/license review remains part of release work.
- [Published Kit release](https://crates.io/crates/gpui-kit/0.6.6), [exact Kit source](https://github.com/longbridge/gpui-kit/tree/9765ae2c9a5eccfa13891248a445991e6f6a09d8), [installation requirements](https://gpui-kit.com/docs/installation/).

Observed migration changes: `ShapedLine::paint` now takes alignment and optional width before window/context; `on_window_closed` receives `(&mut App, WindowId)`; desktop creation uses `gpui_kit::application()`, Kit initialization/assets, and a `Root` wrapper. This list is initial probe evidence, not an exhaustive app-port inventory.
