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

export interface ConfigShells {
  restore: "always" | "never" | "ask";
  persist_on_quit: boolean;
}

export interface ConfigKeybindings {
  new_tab: string;
  close: string;
  split_horizontal: string;
  split_vertical: string;
  zoom: string;
  flip: string;
  advance_queue: string;
}

export interface AppConfig {
  font: ConfigFont;
  scrollback_limit: number;
  cursor: ConfigCursor;
  shell: string;
  padding: number;
  opacity: number;
  theme: ConfigTheme;
  shells: ConfigShells;
  keybindings: ConfigKeybindings;
}

// ========================== Filesystem ==========================

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
}

export interface ResolvedDirectory {
  requested_path: string;
  resolved_path: string;
  exact: boolean;
}

// ========================== Prompt Stacker ==========================

export interface PromptRecord {
  id: string;
  text: string;
  created_at: number;
}

export interface PromptStackerState {
  prompts: PromptRecord[];
  queue: string[];
}

// ========================== Shell Registry ==========================

export type ShellRecordStatus = "active" | "detached" | "closed" | "crashed";

export interface ShellRecord {
  id: string;
  title: string;
  created_at: number;
  last_attached_at: number;
  last_known_cwd?: string | null;
  shell_path?: string | null;
  status: ShellRecordStatus;
  persist_on_quit: boolean;
  closed_at?: number | null;
}

// ========================== Session (layout persistence) ==========================

/** Recursive pane layout — no IDs, freshly assigned on restore. */
export type SavedPane =
  | { type: "terminal"; cwd?: string; shellId?: string }
  | { type: "file-explorer"; path?: string }
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
export const GET_PROMPT_STACKER_STATE_CMD = "get_prompt_stacker_state" as const;
export const SAVE_PROMPT_CMD          = "save_prompt"          as const;
export const EDIT_PROMPT_CMD          = "edit_prompt"          as const;
export const DELETE_PROMPT_CMD        = "delete_prompt"        as const;
export const DUPLICATE_PROMPT_CMD     = "duplicate_prompt"     as const;
export const SET_PROMPT_QUEUE_CMD     = "set_prompt_queue"     as const;
export const EXPORT_PROMPTS_CMD      = "export_prompts"       as const;
export const IMPORT_PROMPTS_CMD      = "import_prompts"       as const;
export const PREPARE_SHELL_REGISTRY_FOR_LAUNCH_CMD = "prepare_shell_registry_for_launch" as const;
export const LIST_SHELL_RECORDS_CMD   = "list_shell_records"   as const;
export const CREATE_SHELL_RECORD_CMD  = "create_shell_record"  as const;
export const ATTACH_SHELL_RECORD_CMD  = "attach_shell_record"  as const;
export const UPDATE_SHELL_RECORD_CMD  = "update_shell_record"  as const;
export const CLOSE_SHELL_RECORD_CMD   = "close_shell_record"   as const;
export const SET_SHELL_PERSIST_ON_QUIT_CMD = "set_shell_persist_on_quit" as const;
export const PREPARE_SHELL_REGISTRY_FOR_SHUTDOWN_CMD = "prepare_shell_registry_for_shutdown" as const;

// Filesystem
export const READ_DIR_CMD             = "read_dir"             as const;
export const READ_FILE_CMD            = "read_file"            as const;
export const WRITE_FILE_CMD           = "write_file"           as const;
export const MOVE_ENTRY_CMD           = "move_entry"           as const;
export const CREATE_DIR_CMD           = "create_dir"           as const;
export const DELETE_ENTRY_CMD         = "delete_entry"         as const;
export const GET_HOME_DIR_CMD         = "get_home_dir"         as const;
export const RESOLVE_EXISTING_DIR_CMD = "resolve_existing_dir" as const;
export const GET_PANE_CWD_CMD        = "get_pane_cwd"          as const;
export const GET_PANE_FOREGROUND_PROCESS_NAME_CMD = "get_pane_foreground_process_name" as const;
