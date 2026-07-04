import { integer, real, sqliteTable, text } from "npm:drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  activeTabId: integer("active_tab_id").notNull().default(0),
  nextId: integer("next_id").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tabs = sqliteTable("tabs", {
  id: integer("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  title: text("title").notNull(),
  activePaneId: integer("active_pane_id").notNull(),
  zoomed: integer("zoomed", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const panes = sqliteTable("panes", {
  id: integer("id").primaryKey(),
  tabId: integer("tab_id")
    .notNull()
    .references(() => tabs.id),
  type: text("type", { enum: ["terminal", "split"] }).notNull(),
  parentId: integer("parent_id"),
  dir: text("dir", { enum: ["h", "v"] }),
  ratio: real("ratio"),
  a: integer("a"),
  b: integer("b"),
  cwd: text("cwd"),
});

export const shells = sqliteTable("shells", {
  id: integer("id").primaryKey(),
  paneId: integer("pane_id").notNull(),
  pid: integer("pid"),
  command: text("command"),
  cwd: text("cwd"),
  status: text("status", { enum: ["running", "exited", "crashed"] })
    .notNull()
    .default("running"),
  startedAt: integer("started_at").notNull(),
  exitedAt: integer("exited_at"),
});
