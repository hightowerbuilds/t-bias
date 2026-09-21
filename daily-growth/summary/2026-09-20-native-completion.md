# Native GPUI completion — 2026-09-20

The user prioritized finishing the native macOS roadmap before returning to controller work.

Implemented the workspace UI around independent terminal-pane entities: tabs, split trees, divider drag, pane activation, zoom, shell lifecycle, cwd capture, SQLite autosave/restore. Existing gamepad input is preserved, polled once per window, and routed to the active pane.

Finished terminal selection/copy, TUI mouse protocols, native composition input, cursor shapes/blink, pixel sizing, terminal response handling, scrollback rendering, combining marks, and palette updates. Added validated TOML configuration, native menus, persistent logging, three themes, Markdown display skins, and keyboard explorer navigation.

Recovered the old prompt-library format and implemented native editing/search/tags/queue/import/export backed by SQLite. Actual pointer/keyboard tests saved multiline text and composed `Café` correctly.

Retired Deno source was archived with SHA-256 verification before deletion: 38 files, including all pre-existing uncommitted Deno work. Legacy SQLite data remains untouched. The original July GPUI plan is archived; the current roadmap now reflects the native implementation.

Validation: 59 unit tests, debug and optimized builds, real native smoke (shell input, selection/copy, splits, zoom, tabs, session survival, SQLite restore, prompts, flip, close, Vim, less, tmux, Markdown, natural shell exit and pane collapse), packaged Launch Services launch, and shell PID cleanup after quit. Workspace saves on both native window close and application quit.

Packaging produces `dist-native/t-bias.app` and `dist-native/t-bias-macos-x86_64.zip`, with native icon and a valid local signature. A Developer ID certificate was found after checking outside the sandbox; the final bundle is Developer ID signed with a secure timestamp and hardened runtime, and its signature/resource seal verify. The signed bundle passed the expanded Launch Services smoke test. Notarization requires the user's keychain profile name, requested asynchronously.

Optional infinite canvas and Linux/Windows are deferred. Existing unrelated daily-growth edits and controller roadmap notes are preserved.
