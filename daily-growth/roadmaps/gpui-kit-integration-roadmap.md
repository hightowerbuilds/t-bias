# GPUI Kit integration roadmap

Started 2026-09-21. **The main-app implementation is now migrated** to Kit 0.6.6 / GPUI pre 0.3.6: bootstrap, Prompts, shared controls, Activity Monitor DataTable, and settings. The isolated candidate has passed terminal/navigation, controller, and new Kit workflow checks, including a 10,000-row virtualized table. See the [migration checkpoint](../summary/2026-09-21-kit-app-migration.md) for final validation and outstanding release checks.

Real OS IME candidate windows, physical 1×/2× transitions, accessibility inspection, other hardware/OS versions, and sustained performance validation remain open. These are not claimed by the completed implementation checkboxes below. The original [probe](../summary/2026-09-21-gpui-kit-probe.md) and [input follow-up](../summary/2026-09-21-kit-input-rendering.md) remain historical evidence.

## Outcome

Give t-bias a consistent native interface using GPUI Kit for everyday controls: prompt editing, search, buttons, menus, settings, and process-table presentation. Preserve the terminal engine, session ownership, workspace model, and stored data. Deliver the prompt panel as the first complete migrated surface, then expand in small, verifiable stages.

## Current foundation

The application uses Rust 1.95.0, exact Kit 0.6.6, and GPUI pre 0.3.6 on Metal with runtime shaders. The direct `gpui` alias resolves to the same package Kit re-exports; the Mac target graph contains one GPUI family and no optional JavaScript/webview runtime. The controller renderer uses wgpu 29.0.4, required by the combined dependency graph. The package minimum is now macOS 15. The pre-migration GPUI 0.2.2/Blade source is preserved in `legacy/pre-kit-2026-09-21.tar.gz`.


| Area | Current ownership | Integration boundary |
| --- | --- | --- |
| Startup | `main.rs`, `menus.rs` | Kit initialization, root view, assets, and focus integration |
| Workspace | `workspace_view.rs`, `workspace.rs`, `pane_tree.rs` | Replace surrounding controls while retaining session keys, split state, and autosave |
| Terminal | `terminal.rs`, `terminal_view.rs`, `terminal_pane.rs`, `input.rs`, `mouse.rs` | Adapt GPUI APIs when necessary; retain PTY, emulator, cell rendering, selection, and protocol behavior |
| Prompts | `prompt_panel.rs`, `prompts.rs` | Kit inputs and buttons around the existing library and queue |
| Activity | `activity/view.rs`, `collector.rs`, `model.rs`, `tree.rs` | Kit search/table presentation around existing snapshots and process identities |
| Files and lessons | `explorer.rs`, `fs.rs`, `markdown.rs` | Shared controls first; assess rich-content replacement separately |
| Controller | `controller.rs`, `controller/`, `gamepad/` | Reusable editor controls around the now-implemented device/profile/draft model; retain its wgpu illustration |
| Storage | `db.rs`, `config.rs`, `activity/preferences.rs` | Keep existing schemas and settings behavior during the UI migration |

`WorkspaceView` owns live terminal entities independently of visible surfaces. Preserve this relationship: a component disappearing from the rendered tree must not close its shell. Activity Monitor uses Kit `DataTable` with virtualized rows. Its adapter resolves selected PID/start identity after snapshot adoption and sorting; widths are session-only and saved preferences retain their existing format.

## Upstream findings and dependency decision

[GPUI Kit](https://gpui-kit.com/docs/) offers unstyled behavior through `gpui-base`, styled controls through `gpui-component`, and a separate JavaScript extension layer through `gpui-shell`. Use the styled Rust components initially; Base is an option for custom visuals where shared behavior is useful.

The [installation guide](https://gpui-kit.com/docs/installation/) recommends `gpui-kit = "0.6"` and using Kit's re-exported GPUI types. It lists macOS 15+ and Rust 1.90+. These are upstream requirements, not verified support for this application's hardware or package.

The [main-branch manifest inspected during research](https://github.com/longbridge/gpui-kit/blob/main/Cargo.toml) declares Kit 0.6.5 and pins `gpui-pre` 0.3.6. This is an observation of a moving branch, not a selected release or proof of publication. Documentation version selectors differed between fetched pages. Phase 0 must select an available release, inspect its exact manifests, and record the resolved versions and features.

**Selected for the experiment:** published `gpui-kit = "=0.6.6"`, Kit/Base/Component/Assets 0.6.6 in its own lockfile, and exact GPUI pre 0.3.6. Registry metadata records Kit revision `9765ae2c9a5eccfa13891248a445991e6f6a09d8` and the GPUI snapshot identifies Zed revision `bcf6582ce3500df93a8a39366640173e6786cea6`. The macOS path uses `gpui-pre-apple` Metal with `runtime_shaders`; there is no Blade feature. The Mac target dependency tree contains one GPUI family and no Kit shell, JavaScript VM, or webview. This was the isolated-probe decision; the main application has since adopted the same Kit/GPUI family.

Current GPUI 0.2.2 entities cannot be assumed interchangeable with Kit's GPUI entities. Migrate the application's GPUI imports and APIs to one compatible dependency family before mixing old custom views with Kit controls. Do not attempt to bridge two GPUI runtimes inside one window.

## Phase 0 — Prove the renderer and dependency combination

- [x] Record the current OS, GPU, SDK/toolchain, renderer features, and baseline build/smoke results. Preserve the current working changes when preparing an isolated experiment; a checkout of HEAD alone does not contain all current work.
- [x] Create a small standalone compatibility example with an exact Kit version and lockfile. Record its source tag or revision, GPUI packages, platform features, minimum OS, license, and build requirements.
- [x] Inspect whether that version offers a suitable Blade path or requires a different renderer. Test the actual supported path; do not assume the old `macos-blade` flag still exists or that the previous Metal problem is fixed.
- [ ] Render a button, editable input, styled text, and a custom canvas in the same window. Exercise focus, clipboard, IME, resizing, transparency, and scale changes.
- [ ] Exercise the terminal cell-rendering path against the candidate GPUI APIs, including ASCII, CJK, combining marks, emoji, selection, and cursor painting.
- [ ] Run both development and packaged release builds on the Intel/AMD Mac. Record Apple Silicon results separately when hardware is available. Capture startup time, idle CPU/RSS, and scrolling responsiveness for comparison.

The mounted-input smoke covers Unicode, simulated marked-text commit, focus isolation, native clipboard actions, undo/redo, multiline editing, resize, scrolling offset, and dark/light changes. The reduced canvas visibly covers ASCII, CJK, combining marks, emoji, ANSI colors, selection, and cursor painting. Real OS IME/candidate-window checks, monitor scale transitions and comparable scrolling measurements remain open. Actual terminal integration and both debug and packaged app workflows now pass.; unchecked combined requirements above include this remaining work.

**Exit:** a reproducible pinned dependency combination renders and accepts input correctly on the development Mac, with a written renderer decision and measured baseline. If it fails, stop the application migration and document the failure. An older compatible component release may be evaluated separately; its feature set must be checked rather than inferred from current Kit docs.

## Phase 1 — Establish Kit inside the application

- [x] Update `Cargo.toml` and `Cargo.lock` to the proven combination. Inspect the dependency tree for duplicate GPUI families and accidental optional runtimes. Keep the default integration entirely Rust.
- [x] Adapt imports, custom elements, input handlers, async updates, and platform bootstrap to the selected GPUI APIs. Keep this change focused on compatibility.
- [x] Initialize Kit and install its root view/assets according to the selected release. Adapt window-close hooks and smoke entry points so they still reach `WorkspaceView` after root wrapping.
- [x] Add a small shared UI/theme module for application color roles, spacing, typography, and component defaults. Map dark/light/Dracula appearance coherently while keeping terminal ANSI colors separate from control colors.
- [x] Define focus and action routing for inputs, menus, dialogs, terminal panes, and footer navigation. Escape and Command-W operate on the owning surface; text and gamepad events cannot fall through an overlay into a PTY.
- [x] Verify existing custom views coexist with Kit controls before converting a whole surface.

**Exit:** the existing application runs on the chosen GPUI family with working fonts, menus, shortcuts, session survival, shutdown, and smoke entry points. Themes remain readable at the existing 640×420 minimum size.

## Phase 2 — Migrate the prompt panel

- [x] Replace search/tags fields with Kit Input and the prompt editor with Textarea, using the APIs available in the pinned version. Replace local button styling with shared Kit controls.
- [x] Adapt change subscriptions and focus requests to Kit input state. Preserve search, tags, duplicate/delete, queue order, import/export, and error handling.
- [x] Preserve Send semantics: insert into the active terminal without Enter. Sending the next queued item advances the queue exactly as before.
- [ ] Verify multiline editing, selection, clipboard, undo/redo, Unicode, IME composition, scrolling, and keyboard-only navigation. Long prompts must remain editable without breaking layout.
- [x] Verify switching away and back preserves the editor draft, and opening/closing the panel returns focus predictably. Activity search has also migrated; the custom text-field module is now removed.

**Exit:** the complete prompt workflow works with Kit controls and existing stored data. Tests cover event routing and send/queue behavior; native smoke covers real focus, input, and rendering.

**First integration milestone:** Phases 0–2 produce a working application with one fully migrated surface. Broader conversion follows evidence from this milestone.

## Phase 3 — Shared application controls

- [x] Convert footer navigation, workspace toolbar buttons, explorer controls, and monitor toolbar controls in separate changes. Preserve labels, shortcuts, selected-state behavior, and terminal focus.
- [ ] Add useful tooltips and accessible names to icon controls. Inspect keyboard focus and the native accessibility tree; library adoption alone does not prove accessibility.
- [ ] Apply shared theme roles consistently to hover, disabled, selected, and focused states. Verify all three configured themes and narrow layouts.
- [x] Keep existing tab/split models and divider behavior. Kit tabs may supply presentation, but terminal ownership remains in `WorkspaceView`.

**Exit:** everyday navigation has consistent controls and focus feedback, with no terminal session restart during surface changes, splits, zoom, or tab reordering.

## Phase 4 — Activity Monitor table

- [x] Replace search and evaluate Kit Table against the current virtualized list. Retain existing sampling, sorting, filtering, and tree calculations outside render callbacks.
- [x] Adapt snapshots into table rows using stable process identity, including process-start identity. Preserve selection across sorting and refresh; PID alone is insufficient.
- [x] Preserve All/My Processes/This Workspace/Active Pane scopes, tree expansion, direct/subtree totals, hidden columns, row copy, lesson links, and Show in Terminal.
- [x] Kit DataTable supports column resizing. Widths are intentionally session-only; the existing preference format is unchanged.
- [x] Preserve unavailable/warming-up values, pause/resume, inactive sampling suspension, and bounded history. Exercise large synthetic snapshots and frequent refresh while scrolling.
- [x] Removed the custom text-field module after Prompts and Activity search migrated.

**Exit:** list/tree behavior and process selection remain correct under refresh. Compare memory and responsiveness with the Phase 0 baseline and retain the existing table if Kit introduces unresolved regressions.

## Phase 5 — Settings and future editor surfaces

- [x] Build a settings view with typed controls for the existing configuration fields. Include validation, Apply/Discard, and a clear indication of settings that require restart.
- [x] Implement a config-save path before enabling Apply: preserve unrelated settings, detect external edits, write atomically, and keep the original file and active settings on failure. Do not silently overwrite invalid configuration.
- [x] Keep Open Configuration available. Treat live reload as a separate behavior change; theme previews must be reversible when a draft is discarded.
- [x] Use shared controls in the visual controller editor only after its device identity, action registry, and draft/apply model are ready in the [controller roadmap](controller-surface-roadmap.md).

**Exit:** supported settings can be edited, saved, reloaded, and discarded predictably. Controller UI readiness is tracked independently and does not block the core Kit integration milestone.

## Later decisions

- **Markdown:** compare Kit TextView with current preview skins, lesson links, tables, and controller-roadmap rendering before choosing replacement. Keep the existing Markdown renderer until feature parity is demonstrated.
- **Docking:** evaluate only if richer panel layouts become a product requirement. Replacing the current binary split tree would require separate persistence and session-lifecycle design.
- **Computer view:** retain custom GPUI geometry and camera/input logic; Kit can supply surrounding controls.
- **JavaScript extensions, webviews, and new platforms:** separate projects with their own requirements.

## Verification and delivery

Deliver dependency/bootstrap changes and each converted surface as independently reviewable changes. Record exact versions, commands, results, hardware, and remaining limitations here as phases complete. Avoid unrelated data-schema changes so earlier builds remain usable with the same data.

| Check | Evidence required |
| --- | --- |
| Build and model behavior | `./scripts/check-native.sh` passes formatting, locked tests, and build |
| Terminal and prompts | `./scripts/check-native.sh --gui` passes, extended for Kit focus/input and prompt workflows |
| Activity and navigation | `./scripts/check-native.sh --activity` passes, extended for converted table behavior |
| Data continuity | Restore a copied existing database/config; verify tabs, splits, prompts, queue, and preferences |
| Input isolation | No unintended PTY bytes while typing in inputs, using dialogs, or navigating utility surfaces |
| Native usability | Keyboard-only use, IME, clipboard, accessibility inspection, all themes, minimum size, scale changes |
| Performance | Compare the same idle, terminal-output, prompt-editing, and large-process-list scenarios with baseline measurements |
| Packaging | `./scripts/package-native.sh` succeeds; launch the resulting app and verify assets, text, input, and available signing/notarization steps |

Run GUI and data-continuity checks with isolated `TBIAS_DATA_DIR` directories and copied fixtures. A passing compile is not renderer evidence. Record missing hardware, tools, or signing credentials as unverified checks rather than successful validation.

For rollback, retain a known-working build and its matching lockfile. Revert the relevant integration change without discarding unrelated work. Validate copied data with that build; config-saving additions must not make rollback silently destructive.

**Done:** the pinned Kit stack renders correctly on validated hardware; prompts and shared controls use the common UI system; Activity retains its behavior and performance; settings save predictably; terminal sessions and existing data survive the migration. Deferred docking, Markdown replacement, and controller development do not expand this completion criterion.

## References

- [GPUI Kit overview and architecture](https://gpui-kit.com/docs/)
- [Installation and platform requirements](https://gpui-kit.com/docs/installation/)
- [Upstream dependency manifest](https://github.com/longbridge/gpui-kit/blob/main/Cargo.toml)
- [Component catalog](https://gpui-kit.com/component/), [Input](https://gpui-kit.com/component/input/), and [Table](https://gpui-kit.com/component/table/)
- [Current native roadmap](gpui-rebuild-roadmap.md), [Activity Monitor roadmap](activity-monitor-roadmap.md), and [controller roadmap](controller-surface-roadmap.md)
