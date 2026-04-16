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
  cwd?: string;
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

/** get_pane_foreground_process_name: Query the active foreground app in a pane PTY. */
export interface GetPaneForegroundProcessNameArgs {
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

export interface ConfigSession {
  restore: "always" | "never" | "ask";
}

export interface AppConfig {
  font: ConfigFont;
  scrollback_limit: number;
  cursor: ConfigCursor;
  shell: string;
  padding: number;
  theme: ConfigTheme;
  session: ConfigSession;
}

// ========================== Filesystem ==========================

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
}

// ========================== Prompt Stacker ==========================

export interface PromptRecord {
  id: string;
  text: string;
  created_at: number;
}

// ========================== Session (layout persistence) ==========================

/** Recursive pane layout — no IDs, freshly assigned on restore. */
export type SavedPane =
  | { type: "terminal" }
  | { type: "file-explorer" }
  | { type: "prompt-stacker" }
  | { type: "editor"; filePath?: string }
  | { type: "split"; dir: "h" | "v"; ratio: number; a: SavedPane; b: SavedPane };

export interface SavedTab {
  layout: SavedPane;
  /** 0-based index into DFS-ordered terminal list for the active pane. */
  activePaneIndex: number;
  title: string;
}

export interface SessionData {
  version: 1;
  activeTabIndex: number;
  tabs: SavedTab[];
}

// ========================== Command names (string constants) ==========================

export const SPAWN_SHELL_CMD          = "spawn_shell"         as const;
export const WRITE_TO_PTY_CMD         = "write_to_pty"        as const;
export const RESIZE_PTY_CMD           = "resize_pty"          as const;
export const CLOSE_PANE_CMD           = "close_pane"          as const;
export const GET_CONFIG_CMD           = "get_config"          as const;
export const SAVE_SESSION_CMD         = "save_session"        as const;
export const LOAD_SESSION_CMD         = "load_session"        as const;
export const SAVE_NAMED_SESSION_CMD   = "save_named_session"  as const;
export const LOAD_NAMED_SESSION_CMD   = "load_named_session"  as const;
export const LIST_NAMED_SESSIONS_CMD  = "list_named_sessions" as const;
export const DELETE_NAMED_SESSION_CMD = "delete_named_session" as const;
export const LIST_PROMPTS_CMD         = "list_prompts"         as const;
export const SAVE_PROMPT_CMD          = "save_prompt"          as const;

// Filesystem
export const READ_DIR_CMD             = "read_dir"             as const;
export const READ_FILE_CMD            = "read_file"            as const;
export const WRITE_FILE_CMD           = "write_file"           as const;
export const MOVE_ENTRY_CMD           = "move_entry"           as const;
export const CREATE_DIR_CMD           = "create_dir"           as const;
export const DELETE_ENTRY_CMD         = "delete_entry"         as const;
export const GET_HOME_DIR_CMD         = "get_home_dir"         as const;
export const GET_PANE_CWD_CMD        = "get_pane_cwd"          as const;
export const GET_PANE_FOREGROUND_PROCESS_NAME_CMD = "get_pane_foreground_process_name" as const;
