---
name: Release build IPC naming
description: Tauri 2 converts Rust snake_case params to camelCase for frontend IPC — always use camelCase in invoke calls
type: feedback
---

Tauri 2 auto-converts Rust snake_case command parameters to camelCase for the JS IPC interface. Always use camelCase keys in `invoke()` calls (e.g. `paneId` not `pane_id`).

**Why:** This caused the release build to silently fail on all PTY commands. The error was only surfaced after adding try/catch around the spawn invoke.

**How to apply:** Any new Tauri command with multi-word params must use camelCase on the frontend side. Also always add error handling around invoke calls to surface failures.
