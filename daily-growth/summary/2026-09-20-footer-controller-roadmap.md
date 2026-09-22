# Footer navigation and Controller roadmap — 2026-09-20

Added a persistent native footer for Terminal, Files, Prompts, Activity, Learn, Computer, and Controller. Command-Option-1 through 7 select the same destinations. Files uses the current pane's explorer, Prompts opens the existing library, and terminal sessions remain alive through navigation. Footer selection follows monitor-internal Back and lesson transitions. Navigation cancels pending split/tab drags and manages focus without creating replacement shells.

Controller currently opens a native roadmap reader. The visual PS2 diagram, physical-device inspection, and mapping editor are intentionally future work. The new `daily-growth/roadmaps/controller-surface-roadmap.md` defines device identity/state, typed actions and versioned profiles, the native diagram, edit/capture/test/apply behavior, and hardware/release acceptance. The original PS2 roadmap links to this expanded implementation plan and distinguishes historical observations from current status.

Prompt and Controller views consume controller input without sending it to a terminal. The Controller page supports keyboard scrolling and Escape; footer shortcuts remain available. A definite document width fixes intrinsic sizing of the long roadmap at small window sizes.

Validation:

- 72 unit tests passed, formatting passed, and the optimized build passed.
- Extended native smoke passed all seven destinations, nested Back state, original shell identity, and prompt/controller input isolation, alongside the existing Activity Monitor/learning/flight checks.
- The smoke now explicitly checks that inactive lessons ignore controller Back instead of assuming the test window keeps focus while the user works.
- Visual checks confirmed the footer and readable Controller roadmap at 640×420; a real pointer click selected Computer, and Command-Option-7/1 opened Controller/Terminal. The 3D scene has limited space at this minimum size; its existing 2D alternative remains available.
- `git diff --check` passed. Isolated preview windows were closed. The user's running app and unrelated changes were preserved; the signed distributed bundle was not replaced.
