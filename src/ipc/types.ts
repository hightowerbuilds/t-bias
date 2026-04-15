// ---------------------------------------------------------------------------
// IPC contract — types for all Tauri commands and events
// ---------------------------------------------------------------------------
// This file explicitly defines the boundary between Rust and TypeScript.
// Both sides must agree on these shapes.

// ========================== Commands (frontend → backend) ==========================

/** spawn_shell: Start a PTY with the given grid dimensions. */
export interface SpawnShellArgs {
  cols: number;
  rows: number;
}

/** write_to_pty: Send data (keystrokes, paste) to the PTY. */
export interface WriteToPtyArgs {
  data: string;
}

/** resize_pty: Notify the PTY of a terminal size change. */
export interface ResizePtyArgs {
  cols: number;
  rows: number;
}

// ========================== Events (backend → frontend) ==========================

/** pty-output: Raw text from the shell process. */
export interface PtyOutputEvent {
  payload: string;
}

/** pty-exit: The shell process has terminated. */
export interface PtyExitEvent {
  // No payload
}

// ========================== Event names (string constants) ==========================

export const PTY_OUTPUT_EVENT = "pty-output" as const;
export const PTY_EXIT_EVENT = "pty-exit" as const;

// ========================== Command names (string constants) ==========================

export const SPAWN_SHELL_CMD = "spawn_shell" as const;
export const WRITE_TO_PTY_CMD = "write_to_pty" as const;
export const RESIZE_PTY_CMD = "resize_pty" as const;
