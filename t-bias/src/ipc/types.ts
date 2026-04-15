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

// ========================== Config (backend → frontend) ==========================

/** get_config: Returns the full configuration from disk (or defaults). */
export interface ConfigTheme {
  background: string;
  foreground: string;
  cursor: string;
  selection_bg: string;
  ansi: string[];
}

export interface ConfigFont {
  family: string;
  size: number;
}

export interface ConfigCursor {
  style: "block" | "underline" | "bar";
  blink: boolean;
}

export interface AppConfig {
  font: ConfigFont;
  scrollback_limit: number;
  cursor: ConfigCursor;
  shell: string;
  padding: number;
  theme: ConfigTheme;
}

// ========================== Command names (string constants) ==========================

export const SPAWN_SHELL_CMD = "spawn_shell" as const;
export const WRITE_TO_PTY_CMD = "write_to_pty" as const;
export const RESIZE_PTY_CMD = "resize_pty" as const;
export const GET_CONFIG_CMD = "get_config" as const;
