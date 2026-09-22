# Controller: see and customize your controls

Started 2026-09-20. Updated 2026-09-21: the footer now opens the working visual map and button editor. Per user direction, the original native-vector plan below became our first **wgpu** integration: an original WGSL controller illustration embedded in GPUI through a bounded offscreen pixel bridge.

Delivered: selected-device telemetry, button/stick visualization, pointer and keyboard control selection, per-surface button overrides, capture with release/timeout, action-name test preview, Apply/Discard/per-surface Reset/Reload, and configuration conflict detection. Stick assignments/calibration remain fixed; analog trigger travel, simulated flight preview, accessibility certification, and physical hardware/release validation remain follow-ups. Unchecked combined requirements below are not claims that the whole feature is missing.

## The experience

Open **Controller** from the footer. See a recognizable PS2-style controller with labeled face buttons, d-pad, shoulders, Start/Select, and both clickable sticks. Press a physical control to see it light up. Select a control on the drawing or in the adjacent list, choose the surface it applies to, and assign an action. Review the change, test it in an isolated preview, and apply it. Return to Terminal, Files, Learn, or Computer with the new mapping active.

Keep the layout useful without a connected device. Show the actual connected device name alongside the PS2-style diagram: the drawing is a logical layout, not a claim that a DualShock 2 has been detected. Missing inputs remain visibly unavailable. A keyboard-accessible list offers every control and action represented by the drawing.

## Foundation and boundaries

Current code owns device polling in `app/src/gamepad/hub.rs`, resolves button profiles in `controller/profile.rs`, routes events in `workspace_view.rs`, maps terminal verbs through `gamepad::binding` and the existing key encoder, and handles learning/flight controls in `activity/view.rs` and `activity/world.rs`. The adapter emits stick-neutral transitions. Native config loading, SQLite persistence, Markdown, and focus isolation already exist.

The original device-identity, shared-stick-state, held-button, and editable-profile gaps are addressed. Trigger travel is still explicitly unavailable. `config.rs` initializes logging; the older controller roadmap's statement that there is no logger is historical.

This roadmap expands the existing PS2 terminal roadmap's logical-pad, HUD, modal, and remapping work. It does not replace its text-entry experiments, workspace chords, or optional haptics. The initial editor changes app actions, not operating-system mappings, arbitrary scripts, or multi-step command macros.

## Input and profile design

Keep hardware calibration and action assignment separate:

1. **Device adapter:** physical button/axis identifiers become logical PS2 controls. Retain a runtime device ID, connection generation, capability information, and per-device neutral/held state.
2. **Profile resolver:** a logical control plus active surface becomes a typed action. Use one resolver for execution, the diagram's labels, and test preview.
3. **Surface dispatcher:** deliver the resolved action once to its owning surface. Terminal keys still use `input::encode_key`; flight keeps continuous axes and held controls.

Start with profiles for Terminal, Files, Learn, and Computer; define the Activity navigation action set before enabling assignments for it. Controller's own edit/capture/preview state consumes input. Prompts and other text editors must not inherit terminal bindings. Keep footer navigation available by mouse and keyboard even if a profile is invalid or every controller button is unassigned.

The implemented schema is `[controller] version = 1`, with sparse button overrides under `[controller.bindings.terminal]`, `.files`, `.learn`, and `.computer`. Example: `circle = "enter"` under the terminal table. Defaults remain immutable in code; missing overrides use defaults. Apply validates and replaces the file atomically, preserving unrelated settings/comments and rejecting external edits, corrupt data, and future versions. Reload saved explicitly accepts external controller changes. Named/exportable profiles and axis configuration remain later work.

## Phase 0 — Device identity and truthful inspection

- [x] Add device IDs to every event and keep sticks/buttons per device. Explicitly select one device for control and inspection; other devices cannot contaminate its state.
- [x] Build a bounded latest-state snapshot for axes and an ordered button/connection event path. Keep the existing device-owned poll thread; do not start another HID reader for the diagram.
- [ ] Distinguish disconnected, initializing, unsupported mapping, and unavailable subsystem states. Report supported controls; represent missing trigger travel as unavailable, not zero.
- [x] Reset state on disconnect, sleep/resume, window deactivation, device change, and profile transition. Require release/neutral before actions resume after capture. Hardware stress validation remains in Phase 4.
- [ ] Investigate the actual DS2-to-USB adapter and DS4 connection paths with hardware. Record observed identifiers and mapping evidence; do not assume adapter button indices or pressure support.

**Exit:** deterministic multi-device fixtures show no cross-device motion or stuck buttons; the selected physical device can reconnect without restarting the app. Record which hardware paths were actually tested.

## Phase 1 — One action registry and profile resolver

- [ ] Define stable IDs, display names, supported surfaces, and activation semantics for actions: press once, release, held/repeated, and continuous axes.
- [x] Extract today's terminal, lesson, and flight button defaults into data-driven profiles without changing behavior. Keep physical calibration separate from surface bindings.
- [ ] Define valid assignment types: a digital button cannot accidentally become an unbounded analog axis; specify direction, scale, dead zone, sensitivity, and invert-Y for supported axis actions.
- [ ] Define conflict rules. One control has one effective assignment per context; duplicate actions on different controls are allowed and shown. Chords, modes, and inheritance need explicit precedence before they are offered.
- [ ] Implement versioned parse/validate/save/load, defaults, per-surface reset, and full reset. Invalid drafts do not alter the active profile. Failed saves leave the current profile and original file intact.

**Exit:** default profiles reproduce existing terminal bytes and lesson/flight actions in unit fixtures; valid settings round-trip, and corrupt/future-version files survive unchanged.

## Phase 2 — Visual PS2 controller

- [x] Build original wgpu/WGSL geometry: grips/body, d-pad, colored triangle/circle/cross/square, shoulder rows, Start/Select, stick positions, and L3/R3 labels. GPUI overlays text; no generated image or controller-photo asset is required.
- [ ] Show hover, keyboard focus, selected control, held state, and stick deflection distinctly. Use text/shape as well as color. Do not animate unsupported measurements.
- [x] Pair the drawing with a control list and current-action inspector. At narrow widths, stack the inspector in a scrollable layout.
- [x] Coalesce visual state updates at a bounded render cadence (at most approximately 30 fps). Idle/disconnected drawings do not need a continuous animation loop. Rendering/readback was measured on Intel Metal; complete displayed-frame/input latency measurement remains pending.

**Exit:** every logical control is selectable by pointer and keyboard, including shoulders and stick clicks. Verify the native accessibility tree and screen-reader labels; drawing natively is not itself proof of accessibility.

## Phase 3 — Edit, capture, test, apply

- [x] Select a target surface and control, choose from compatible actions, and show the effective mapping plus whether it is default or overridden.
- [x] Offer an explicit **Press a control** capture mode. Capture recognizes the source control, waits for release, and never executes its previous action. Escape cancels; timeout, disconnect, and focus loss end capture safely.
- [x] Keep changes in a draft with Apply, Discard, and Reset. Surface navigation with a dirty draft preserves it; it must not silently apply it.
- [ ] Provide a sandboxed test area showing resolved action names, encoded key descriptions, and a small simulated flight response. Test mode cannot write PTY bytes, submit commands, move the live camera, or trigger app actions.
- [x] On Apply, persist successfully, swap the validated active profile, clear held/repeat state, and show the result. Return a useful error on failure.

**Exit:** remapping Circle from interrupt to another action changes only the chosen context after Apply. Capture/test produces zero PTY input. Discard restores the prior effective mapping; Reset remains recoverable without a gamepad.

## Phase 4 — Hardware validation and release

- [ ] Test real DS4 input on each available transport and DS2 through the actual USB adapter. Keep untested device/transport combinations labeled unverified.
- [ ] Cover two controllers, disconnect while held, neutral drift, rapid presses, window switching, profile switching during motion, and reconnect with a changed runtime device ID.
- [ ] Native GUI smoke: footer → Controller → select/capture → edit → preview → Apply → return to each supported surface. Verify both the intended action and no cross-surface input leakage.
- [ ] Check keyboard-only use, 640×420 layout, dark/light themes, readable focus/contrast, and accessibility. Compare idle and active CPU/render overhead with the current input path.
- [ ] Test settings migration, external-edit conflict, read-only storage, interrupted writes, and fallback to defaults in the packaged signed app. Publish a hardware support matrix and user-facing reset instructions.

**Done:** a user can identify a button on the diagram, understand its action for a surface, safely remap and test it, restart with the mapping preserved, and recover defaults. Only validated device paths are described as supported.

## Later work

Text entry (radial versus grid), chords and modal bindings, reusable/exportable profiles, additional device diagrams, workspace commands, haptics, and advanced diagnostics follow the working editor. Do not add them to the first visual-remapping milestone without revisiting its acceptance criteria.

Recommended order: identity/state → action registry and profiles → diagram → edit/capture/test → hardware and packaged validation. This keeps the visual labels and actual behavior backed by the same model throughout implementation.
