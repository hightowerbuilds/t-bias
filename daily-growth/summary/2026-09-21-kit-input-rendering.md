# Kit input and rendering follow-up

Continued Phase 0 in the isolated compatibility lab. Main application source, dependencies, user data, and distributed bundles were not changed by this follow-up.

## Changes

- Inspected the exact installed Kit 0.6.6 Root implementation: it paints `theme.tokens.background` before applying style refinements. The previous translucent child sat over that opaque background. `--transparent` now overrides Root to transparent black and paints the probe background at 75% alpha. Real desktop compositing remains unverified.
- Added `--long`, containing 300 lines of Unicode text, and `KIT_DISPLAY` logging when actual scale or viewport size changes.
- Extended mounted-window smoke to cover button clicks, pointer focus, Tab/Shift-Tab, long-text wheel scrolling isolated from the parent scroller, caret navigation to document ends, full selection/copy, compact resizing, and marked-text cancellation at the input boundary. Uses macOS Command-Up/Down document navigation.
- Deferred synthetic pointer/key/wheel dispatch until the current Probe update releases its borrow. Caught smoke assertion failures restore the saved clipboard before exiting nonzero.
- Added reproducible manual instructions in the compatibility lab README for actual candidate windows, compositing, and physical display transitions.

## Evidence and limits

Final non-GUI `./check.sh` passed formatting, the locked development build, and the dependency-family/optional-runtime guard. `git diff --check` also passed. No dependencies were changed.

The first expanded GUI run failed on reentrant pointer dispatch. After deferring pointer events, the second run passed button activation and pointer search focus, then failed at step 18 on reentrant keyboard dispatch. That second failure restored the clipboard. The final source defers key and wheel dispatch too; the requested final GUI rerun was declined, so the extended sequence has **not passed end to end**. The earlier first failure occurred before assertion-time clipboard restoration was added and did not restore the clipboard.

Read-only AppKit inspection reported one **LG HDR WQHD, 3440×1440 logical points, scale 1×**. Existing Accessibility and screen-capture access were available. Enabled input sources included U.S.; source enumeration found installed Japanese and Chinese modes. Permission to run a real OS input-method driver was declined; no input source was changed. The unrun driver and its telemetry were removed rather than included as unverified test infrastructure.

No new packaged-build, transparency screenshot, native candidate-window, or physical 1×/2× result is claimed. The original probe's recorded passes remain historical evidence, not verification of this modified smoke. The main app remains on GPUI 0.2.2/Blade.

## Resume

1. Run `experiments/gpui-kit/check.sh --smoke` in a logged-in desktop and resolve any further failures; require both acceptance and final smoke markers.
2. Visually check `--long --transparent` in dark/light and compact/default sizes, including caret visibility and compositing over contrasting backgrounds.
3. Exercise a real OS input method with candidate selection, commit, and cancellation; restore the user's previous input source.
4. Make a real 2× display available and move the window between scales. Do not substitute changed font size or a synthetic scale override for the platform transition.
5. Repackage and repeat native input/rendering checks on the optimized bundle before updating Phase 0 acceptance.
