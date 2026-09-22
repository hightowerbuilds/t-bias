# Controller map: first embedded wgpu display

The Controller footer destination now opens a working PS2-style map and button editor. The user chose this as the first wgpu challenge before changing the educational Computer scene.

## Delivered

- Original procedural WGSL illustration: body, grips, colored face symbols, d-pad, shoulders, Start/Select, and clickable analog sticks. GPUI supplies text labels and the surrounding editor.
- Pinned wgpu 29.0.3 on Metal. A background worker renders BGRA offscreen, reads back pixels, and publishes a GPUI image. One replaceable scene, bounded completion notifications, reusable texture/readback resources, maximum width 1400 pixels, and a roughly 30 fps ceiling bound the work. Replaced atlas images are evicted; hidden/inactive or unchanged scenes stop rendering.
- One gilrs polling thread, independent per-connection state, selected-device inspection/routing, capability indicators, held-button snapshots, coalesced axes, and bounded ordered button edges. Overflow and transitions clear actions and require neutral input. Reconnects receive fresh runtime IDs.
- Compatible button actions for Terminal, Files, Learn, and Computer, backed by the same typed profile for labels, preview, and execution. Stick assignments remain fixed. No scripts, macros, or OS remapping.
- Pointer/keyboard selection, capture with release and timeout, action-name draft testing without execution, Apply/Discard/per-surface Reset/Reload, and drafts preserved during navigation.
- Sparse version-1 TOML overrides. Apply validates, checks for external edits, preserves unrelated formatting/comments, and atomically replaces the configuration before activating it. Corrupt/future-version files are preserved.
- Wide map/inspector layout and stacked, scrollable compact layout. Page Up/Down and Home support scrolling; fixed actions/footer remain available.

## Verification and limits

79 Rust tests pass, including default action compatibility, contextual remapping/release, configuration round trips/conflicts/invalid files, control hit testing, per-device fixtures, edge overflow, and diagonal-stick neutral handling.

The actual GPU probe rendered at 1000×580 on **Intel(R) UHD Graphics 630 · Metal**, compared neutral and pressed/stick-deflected frames, and wrote an inspected PNG. One observed render plus readback took **32.67 ms**. This is a single development measurement, not a displayed-frame rate, input-latency benchmark, or prediction for continuous 3D rendering.

The native controller smoke exercises an embedded GPU frame, capture/release without PTY changes, saved Circle → Enter dispatch, first stick motion after navigation, and paused hidden rendering. Native navigation/flight checks exercise the existing Activity, Learn, Computer, Prompts, Files, and terminal boundaries. Synthetic fixtures disable real polling so attached hardware cannot overwrite test input.

Checks caught and corrected the first-button/first-stick transition gates. The first capture retry passed after closing an earlier preview; window focus can cancel capture by design. The older flight fixture also needed an explicit centered snapshot after its synthetic screen transition.

A physical **PS4 Controller** was detected with **SdlMappings** during the live preview. This confirms discovery, not full button/transport validation. DS2 adapters, DS4 transports, reconnect/held-input hardware stress tests, Apple Silicon/AMD GPU runs, screen-reader accessibility, and signed-package testing remain unverified. Trigger travel is unavailable; axis calibration/remapping, simulated flight preview, and named/exportable profiles remain future work.

Run `./scripts/check-native.sh --controller` for the GPU and native controller smoke; `--activity` exercises the existing monitor/navigation flow. GUI tests require a logged-in desktop and an active test window. Normal user data is not used by these fixtures.

GPUI still uses Blade, and the Computer scene still uses its existing renderer. This first bridge proves that wgpu can be embedded in the app; the [virtual-computer research](../Research/wgpu-virtual-computer.md) retains the larger performance/integration questions.
