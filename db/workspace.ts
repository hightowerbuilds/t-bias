import { eq, inArray } from "npm:drizzle-orm";
import { db } from "./client.ts";
import { panes, tabs, workspaces } from "./schema.ts";
import type { PaneMap, Pane, SplitPane, TerminalPane, ExplorerPane } from "../src/pane-tree.ts";

export interface SavedTab {
  id: number;
  title: string;
  activePaneId: number;
  zoomed: boolean;
  sortOrder: number;
  rootId: number;
  panes: PaneMap;
}

export interface SavedWorkspace {
  workspaceId: number;
  name: string;
  activeTabId: number;
  nextId: number;
  tabs: SavedTab[];
}

const WORKSPACE_ID = 1;
const WORKSPACE_NAME = "default";

function paneFromRow(row: typeof panes.$inferSelect): Pane {
  if (row.type === "split") {
    return {
      type: "split",
      id: row.id,
      dir: row.dir!,
      ratio: row.ratio ?? 0.5,
      a: row.a!,
      b: row.b!,
    } as SplitPane;
  }
  if (row.type === "explorer") {
    return {
      type: "explorer",
      id: row.id,
      cwd: row.cwd ?? undefined,
    } as ExplorerPane;
  }
  return {
    type: "terminal",
    id: row.id,
    cwd: row.cwd ?? undefined,
  } as TerminalPane;
}

function paneToRows(tabId: number, paneMap: PaneMap): (typeof panes.$inferInsert)[] {
  return Object.values(paneMap).map((pane) => {
    if (pane.type === "split") {
      return {
        id: pane.id,
        tabId,
        type: "split" as const,
        parentId: null, // rebuilt from tree; recompute root from tree shape
        dir: pane.dir,
        ratio: pane.ratio,
        a: pane.a,
        b: pane.b,
        cwd: null,
      };
    }
    return {
      id: pane.id,
      tabId,
      type: pane.type,
      parentId: null,
      dir: null,
      ratio: null,
      a: null,
      b: null,
      cwd: pane.cwd ?? null,
    };
  });
}

/** Recompute parentId from the pane tree so each child points to its parent. */
function assignParents(
  rows: (typeof panes.$inferInsert)[],
  paneMap: PaneMap,
  rootId: number,
): (typeof panes.$inferInsert)[] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  function visit(parentId: number | null, id: number) {
    const row = byId.get(id);
    if (!row) return;
    row.parentId = parentId;
    const pane = paneMap[id];
    if (pane?.type === "split") {
      visit(id, pane.a);
      visit(id, pane.b);
    }
  }

  visit(null, rootId);
  return rows;
}

/** Find the root pane of a tab: the one with no parent. */
function findRootId(rows: (typeof panes.$inferSelect)[]): number | null {
  const children = new Set<number>();
  for (const row of rows) {
    if (row.a) children.add(row.a);
    if (row.b) children.add(row.b);
  }
  for (const row of rows) {
    if (!children.has(row.id)) return row.id;
  }
  return null;
}

export async function loadWorkspace(): Promise<SavedWorkspace | null> {
  const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID)).limit(1);
  if (wsRows.length === 0) return null;
  const ws = wsRows[0];

  const tabRows = await db.select().from(tabs).where(eq(tabs.workspaceId, WORKSPACE_ID)).orderBy(tabs.sortOrder);
  const savedTabs: SavedTab[] = [];

  for (const tabRow of tabRows) {
    const paneRows = await db.select().from(panes).where(eq(panes.tabId, tabRow.id));
    const paneMap: PaneMap = {};
    for (const row of paneRows) {
      paneMap[row.id] = paneFromRow(row);
    }
    const rootId = findRootId(paneRows) ?? tabRow.activePaneId;

    savedTabs.push({
      id: tabRow.id,
      title: tabRow.title,
      activePaneId: tabRow.activePaneId,
      zoomed: tabRow.zoomed,
      sortOrder: tabRow.sortOrder,
      rootId,
      panes: paneMap,
    });
  }

  return {
    workspaceId: ws.id,
    name: ws.name,
    activeTabId: ws.activeTabId,
    nextId: ws.nextId,
    tabs: savedTabs,
  };
}

export async function saveWorkspace(state: SavedWorkspace): Promise<void> {
  const now = Date.now();

  await db.transaction(async (tx) => {
    await tx
      .insert(workspaces)
      .values({
        id: WORKSPACE_ID,
        name: WORKSPACE_NAME,
        activeTabId: state.activeTabId,
        nextId: state.nextId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          name: WORKSPACE_NAME,
          activeTabId: state.activeTabId,
          nextId: state.nextId,
          updatedAt: now,
        },
      });

    const existingTabs = await tx.select({ id: tabs.id }).from(tabs).where(eq(tabs.workspaceId, WORKSPACE_ID));
    const existingTabIds = existingTabs.map((t) => t.id);
    if (existingTabIds.length > 0) {
      await tx.delete(panes).where(inArray(panes.tabId, existingTabIds));
    }
    await tx.delete(tabs).where(eq(tabs.workspaceId, WORKSPACE_ID));

    for (const tab of state.tabs) {
      await tx.insert(tabs).values({
        id: tab.id,
        workspaceId: WORKSPACE_ID,
        title: tab.title,
        activePaneId: tab.activePaneId,
        zoomed: tab.zoomed,
        sortOrder: tab.sortOrder,
      });

      let paneRows = paneToRows(tab.id, tab.panes);
      paneRows = assignParents(paneRows, tab.panes, tab.rootId);
      if (paneRows.length > 0) {
        await tx.insert(panes).values(paneRows);
      }
    }
  });
}
