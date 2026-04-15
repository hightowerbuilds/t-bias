// ---------------------------------------------------------------------------
// IPC contract — types for all Tauri commands and events
// ---------------------------------------------------------------------------
// This file explicitly defines the boundary between Rust and TypeScript.
// Both sides must agree on these shapes.

// ========================== Commands (frontend → backend) ==========================

/** spawn_shell: Start a PTY for a specific tab. */
export interface SpawnShellArgs {
  tab_id: number;
  cols: number;
  rows: number;
  shell?: string;
}

/** write_to_pty: Send data (keystrokes, paste) to a tab's PTY. */
export interface WriteToPtyArgs {
  tab_id: number;
  data: string;
}

/** resize_pty: Notify a tab's PTY of a terminal size change. */
export interface ResizePtyArgs {
  tab_id: number;
  cols: number;
  rows: number;
}

/** close_tab: Kill a tab's PTY and free its resources. */
export interface CloseTabArgs {
  tab_id: number;
}

// ========================== Events (backend → frontend) ==========================

/** pty-output-{tabId}: Raw text from a tab's shell process. */
export interface PtyOutputEvent {
  payload: string;
}

/** pty-exit-{tabId}: A tab's shell process has terminated. */
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

export const SPAWN_SHELL_CMD = "spawn_shell" as const;
export const WRITE_TO_PTY_CMD = "write_to_pty" as const;
export const RESIZE_PTY_CMD = "resize_pty" as const;
export const CLOSE_TAB_CMD = "close_tab" as const;
export const GET_CONFIG_CMD = "get_config" as const;
