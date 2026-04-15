// ---------------------------------------------------------------------------
// IPC contract — types for all Tauri commands and events
// ---------------------------------------------------------------------------
// This file explicitly defines the boundary between Rust and TypeScript.
// Both sides must agree on these shapes.

// ========================== Commands (frontend → backend) ==========================

/** spawn_shell: Start a PTY for a specific pane. */
export interface SpawnShellArgs {
  pane_id: number;
  cols: number;
  rows: number;
  shell?: string;
}

/** write_to_pty: Send data (keystrokes, paste) to a pane's PTY. */
export interface WriteToPtyArgs {
  pane_id: number;
  data: string;
}

/** resize_pty: Notify a pane's PTY of a terminal size change. */
export interface ResizePtyArgs {
  pane_id: number;
  cols: number;
  rows: number;
}

/** close_pane: Kill a pane's PTY and free its resources. */
export interface ClosePaneArgs {
  pane_id: number;
}

// ========================== Events (backend → frontend) ==========================

/** pty-output-{paneId}: Raw text from a pane's shell process. */
export interface PtyOutputEvent {
  payload: string;
}

/** pty-exit-{paneId}: A pane's shell process has terminated. */
export interface PtyExitEvent {
  // No payload
}

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

export const SPAWN_SHELL_CMD  = "spawn_shell"  as const;
export const WRITE_TO_PTY_CMD = "write_to_pty" as const;
export const RESIZE_PTY_CMD   = "resize_pty"   as const;
export const CLOSE_PANE_CMD   = "close_pane"   as const;
export const GET_CONFIG_CMD   = "get_config"   as const;
