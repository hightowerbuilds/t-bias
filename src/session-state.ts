import { leafIds, type EditorPane, type PaneMap, type SplitPane, type TerminalPane } from "./pane-tree";
import type { SavedPane, SavedTab, SessionData } from "./ipc/types";
import type { WorkspaceTabState } from "./workspace-state";

export type SessionTabState = WorkspaceTabState;

export function tabToSavedTab(t: SessionTabState): SavedTab {
  function serializePane(id: number): SavedPane {
    const pane = t.panes[id];
    if (pane.type === "terminal") {
      return {
        type: "terminal",
        cwd: t.paneCwds[id] ?? pane.cwd,
        shellId: (pane as TerminalPane).shellId,
      };
    }
    if (pane.type === "file-explorer") {
      return {
        type: "file-explorer",
        path: t.paneCwds[id],
      };
    }
    if (pane.type === "prompt-stacker") {
      return { type: "prompt-stacker" };
    }
    if (pane.type === "editor") {
      return { type: "editor", filePath: (pane as EditorPane).filePath };
    }
    const split = pane as SplitPane;
    return {
      type: "split",
      dir: split.dir,
      ratio: split.ratio,
      a: serializePane(split.a),
      b: serializePane(split.b),
    };
  }

  const leaves = leafIds(t.panes, t.rootId);
  return {
    layout: serializePane(t.rootId),
    activePaneIndex: Math.max(0, leaves.indexOf(t.activePaneId)),
    title: t.title,
  };
}

export function savedTabToTabState(
  saved: SavedTab,
  newId: () => number,
): SessionTabState {
  const leafPaneIds: number[] = [];

  function buildPane(node: SavedPane): {
    id: number;
    panes: PaneMap;
    paneTitles: Record<number, string>;
    paneCwds: Record<number, string>;
  } {
    if (node.type === "terminal") {
      const id = newId();
      leafPaneIds.push(id);
      return {
        id,
        panes: { [id]: { type: "terminal", id, cwd: node.cwd, shellId: node.shellId } },
        paneTitles: { [id]: "Shell" },
        paneCwds: node.cwd ? { [id]: node.cwd } : {},
      };
    }

    if (node.type === "file-explorer") {
      const id = newId();
      leafPaneIds.push(id);
      return {
        id,
        panes: { [id]: { type: "file-explorer", id } },
        paneTitles: { [id]: "Files" },
        paneCwds: node.path ? { [id]: node.path } : {},
      };
    }

    if (node.type === "prompt-stacker") {
      const id = newId();
      leafPaneIds.push(id);
      return {
        id,
        panes: { [id]: { type: "terminal", id } },
        paneTitles: { [id]: "Shell" },
        paneCwds: {},
      };
    }

    if (node.type === "editor") {
      const id = newId();
      leafPaneIds.push(id);
      return {
        id,
        panes: { [id]: { type: "editor", id, filePath: node.filePath } as EditorPane },
        paneTitles: { [id]: node.filePath ? node.filePath.split("/").pop()! : "Untitled" },
        paneCwds: {},
      };
    }

    const splitId = newId();
    const left = buildPane(node.a);
    const right = buildPane(node.b);
    return {
      id: splitId,
      panes: {
        ...left.panes,
        ...right.panes,
        [splitId]: { type: "split", id: splitId, dir: node.dir, ratio: node.ratio, a: left.id, b: right.id },
      },
      paneTitles: {
        ...left.paneTitles,
        ...right.paneTitles,
      },
      paneCwds: {
        ...left.paneCwds,
        ...right.paneCwds,
      },
    };
  }

  const { id: rootId, panes, paneTitles, paneCwds } = buildPane(saved.layout);
  const activePaneId =
    leafPaneIds[Math.min(saved.activePaneIndex, leafPaneIds.length - 1)] ??
    leafPaneIds[0];
  const fallbackTitle = paneTitles[activePaneId] ?? "Shell";
  const title = saved.title === "Prompt Stacker" ? fallbackTitle : saved.title ?? fallbackTitle;

  return {
    id: newId(),
    title,
    hasActivity: false,
    rootId,
    activePaneId,
    panes,
    paneTitles,
    paneProcessTitles: {},
    paneCwds,
    zoomed: false,
  };
}

// ---------------------------------------------------------------------------
// Workspace-level serialization — wraps all tabs into a single SessionData
// ---------------------------------------------------------------------------

export function workspaceToSessionData(
  tabs: SessionTabState[],
  activeTabId: number,
): SessionData {
  const activeTabIndex = Math.max(0, tabs.findIndex((t) => t.id === activeTabId));
  return {
    version: 1,
    activeTabIndex,
    tabs: tabs.map(tabToSavedTab),
  };
}

export function sessionDataToWorkspace(
  data: SessionData,
  newId: () => number,
): { tabs: SessionTabState[]; activeTabIndex: number } {
  // Version guard — reject unknown formats rather than silently corrupting state.
  // When a future version bumps the format, add migration logic here.
  if (data.version !== 1) {
    return { tabs: [], activeTabIndex: 0 };
  }
  const tabs = data.tabs.map((t) => savedTabToTabState(t, newId));
  const activeTabIndex = Math.min(
    Math.max(0, data.activeTabIndex),
    tabs.length - 1,
  );
  return { tabs, activeTabIndex };
}
