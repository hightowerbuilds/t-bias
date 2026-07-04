import { sqlite } from "./client.ts";

export function migrate() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      active_tab_id INTEGER NOT NULL DEFAULT 0,
      next_id INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      active_pane_id INTEGER NOT NULL,
      zoomed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS panes (
      id INTEGER PRIMARY KEY,
      tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('terminal', 'split')),
      parent_id INTEGER,
      dir TEXT CHECK(dir IN ('h', 'v')),
      ratio REAL,
      a INTEGER,
      b INTEGER,
      cwd TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tabs_workspace ON tabs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_panes_tab ON panes(tab_id);
  `);
}
