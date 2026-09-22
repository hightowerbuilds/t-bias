# Retired Deno implementation

`deno-source-2026-09-20.tar.gz` preserves the previous Deno/SolidJS/xterm.js app and its Rust PTY sidecar, including the uncommitted Markdown-preview work present before native completion. Every archived source file was verified against `deno-source-2026-09-20.sha256.json` before the original was removed.

Extract into a separate directory to inspect or rebuild it. Dependencies and compiled output are omitted. Existing legacy SQLite data in the repository's ignored `data/` directory is retained. The native app uses its own SQLite database and schema; it does not migrate or overwrite the old Deno database.

This archive is historical source, not a dependency of the native app.

## Pre-Kit native implementation

`pre-kit-2026-09-21.tar.gz` preserves the complete pre-migration source, including uncommitted Activity/controller/input work and the GPUI 0.2.2 lockfile. Verify it with the adjacent `.sha256` file. Extract into a separate directory; do not overwrite current work. Build artifacts and dependencies are omitted. This archive is a rollback reference, not an application dependency.
