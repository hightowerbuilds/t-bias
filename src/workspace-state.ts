import {
  closePane,
  findAdjacent,
  leafIds,
  splitPane,
  terminalIds,
  toggleFlip,
  type PaneMap,
  type SplitPane,
  type EditorPane,
  type CanvasPane,
} from "./pane-tree";

export interface WorkspaceTabState {
  id: number;
  title: string;
  hasActivity: boolean;
  rootId: number;
  activePaneId: number;
  panes: PaneMap;
  paneTitles: Record<number, string>;
  paneProcessTitles: Record<number, string>;
  paneCwds: Record<number, string>;
  zoomed: boolean;
}

export interface ShellTabOptions {
  cwd?: string;
  shellId?: string;
  title?: string;
}

export interface WorkspaceState {
  tabs: WorkspaceTabState[];
  activeTabId: number;
}

export interface WorkspaceMutationResult extends WorkspaceState {
  closeTerminalPaneIds: number[];
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function displayTitle(t: WorkspaceTabState, paneId: number): string {
  return t.paneProcessTitles[paneId] ?? t.paneTitles[paneId] ?? "Shell";
}

function replaceTabAtIndex(
  tabs: WorkspaceTabState[],
  idx: number,
  nextTab: WorkspaceTabState,
): WorkspaceTabState[] {
  return tabs.map((tab, i) => (i === idx ? nextTab : tab));
}

function normalizeShellTabOptions(input?: string | ShellTabOptions): ShellTabOptions {
  if (!input) return {};
  return typeof input === "string" ? { cwd: input } : input;
}

export function makeShellTab(newId: () => number, input?: string | ShellTabOptions): WorkspaceTabState {
  const options = normalizeShellTabOptions(input);
  const paneId = newId();
  const title = options.title ?? "Shell";
  return {
    id: newId(),
    title,
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "terminal", id: paneId, cwd: options.cwd, shellId: options.shellId } },
    paneTitles: { [paneId]: title },
    paneProcessTitles: {},
    paneCwds: options.cwd ? { [paneId]: options.cwd } : {},
    zoomed: false,
  };
}

export function makeFileExplorerTab(newId: () => number, initialPath?: string): WorkspaceTabState {
  const paneId = newId();
  return {
    id: newId(),
    title: "Files",
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "file-explorer", id: paneId } },
    paneTitles: { [paneId]: "Files" },
    paneProcessTitles: {},
    paneCwds: initialPath ? { [paneId]: initialPath } : {},
    zoomed: false,
  };
}

export function makeEditorTab(newId: () => number, filePath?: string): WorkspaceTabState {
  const paneId = newId();
  const title = filePath ? filePath.split("/").pop()! : "Untitled";
  return {
    id: newId(),
    title,
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "editor", id: paneId, filePath } as EditorPane },
    paneTitles: { [paneId]: title },
    paneProcessTitles: {},
    paneCwds: {},
    zoomed: false,
  };
}

export function makeCanvasTab(newId: () => number): WorkspaceTabState {
  const paneId = newId();
  return {
    id: newId(),
    title: "Canvas",
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "canvas", id: paneId } as CanvasPane },
    paneTitles: { [paneId]: "Canvas" },
    paneProcessTitles: {},
    paneCwds: {},
    zoomed: false,
  };
}

export function splitActivePaneInWorkspace(
  state: WorkspaceState,
  dir: "h" | "v",
  newId: () => number,
): WorkspaceState {
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (idx < 0) return state;
  const tab = state.tabs[idx];
  if (tab.zoomed) return state;

  const splitId = newId();
  const newLeafId = newId();
  const { panes: newPanes, rootId: newRootId } = splitPane(
    tab.panes,
    tab.rootId,
    tab.activePaneId,
    dir,
    splitId,
    newLeafId,
  );

  const nextTab: WorkspaceTabState = {
    ...tab,
    panes: newPanes,
    rootId: newRootId,
    activePaneId: newLeafId,
    paneTitles: {
      ...tab.paneTitles,
      [newLeafId]: "Shell",
    },
    paneProcessTitles: { ...tab.paneProcessTitles },
  };
  delete nextTab.paneProcessTitles[newLeafId];

  return {
    tabs: replaceTabAtIndex(state.tabs, idx, nextTab),
    activeTabId: state.activeTabId,
  };
}

export function closeTabInWorkspace(
  state: WorkspaceState,
  closingTabId: number,
  makeReplacementTab: (cwd?: string) => WorkspaceTabState,
  replacementPath?: string,
): WorkspaceMutationResult {
  const idx = state.tabs.findIndex((tab) => tab.id === closingTabId);
  if (idx < 0) {
    return { ...state, closeTerminalPaneIds: [] };
  }

  const closingTab = state.tabs[idx];
  const closeTerminalPaneIds = terminalIds(closingTab.panes, closingTab.rootId);

  if (state.tabs.length === 1) {
    const replacement = makeReplacementTab(replacementPath);
    return {
      tabs: [replacement],
      activeTabId: replacement.id,
      closeTerminalPaneIds,
    };
  }

  const activeTabId = closingTabId === state.activeTabId
    ? (idx > 0 ? state.tabs[idx - 1] : state.tabs[idx + 1]).id
    : state.activeTabId;

  return {
    tabs: state.tabs.filter((tab) => tab.id !== closingTabId),
    activeTabId,
    closeTerminalPaneIds,
  };
}

export function closeActivePaneInWorkspace(
  state: WorkspaceState,
  makeReplacementTab: (cwd?: string) => WorkspaceTabState,
  replacementPath?: string,
): WorkspaceMutationResult {
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (idx < 0) {
    return { ...state, closeTerminalPaneIds: [] };
  }

  const tab = state.tabs[idx];
  if (leafIds(tab.panes, tab.rootId).length <= 1) {
    return closeTabInWorkspace(state, tab.id, makeReplacementTab, replacementPath);
  }

  if (tab.zoomed) {
    return {
      tabs: replaceTabAtIndex(state.tabs, idx, { ...tab, zoomed: false }),
      activeTabId: state.activeTabId,
      closeTerminalPaneIds: [],
    };
  }

  const closingPaneId = tab.activePaneId;
  const { panes: newPanes, rootId: newRootId, focusId } = closePane(
    tab.panes,
    tab.rootId,
    closingPaneId,
  );

  const paneTitles = { ...tab.paneTitles };
  const paneProcessTitles = { ...tab.paneProcessTitles };
  const paneCwds = { ...tab.paneCwds };
  delete paneTitles[closingPaneId];
  delete paneProcessTitles[closingPaneId];
  delete paneCwds[closingPaneId];

  const nextTab: WorkspaceTabState = {
    ...tab,
    panes: newPanes,
    rootId: newRootId,
    activePaneId: focusId,
    paneTitles,
    paneProcessTitles,
    paneCwds,
    title: displayTitle(
      {
        ...tab,
        panes: newPanes,
        rootId: newRootId,
        activePaneId: focusId,
        paneTitles,
        paneProcessTitles,
        paneCwds,
      },
      focusId,
    ),
  };

  return {
    tabs: replaceTabAtIndex(state.tabs, idx, nextTab),
    activeTabId: state.activeTabId,
    closeTerminalPaneIds: tab.panes[closingPaneId]?.type === "terminal" ? [closingPaneId] : [],
  };
}

export function activatePaneInWorkspace(state: WorkspaceState, paneId: number): WorkspaceState {
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (idx < 0) return state;
  const tab = state.tabs[idx];
  const nextTab: WorkspaceTabState = {
    ...tab,
    activePaneId: paneId,
    title: displayTitle(tab, paneId),
    hasActivity: false,
  };
  return {
    tabs: replaceTabAtIndex(state.tabs, idx, nextTab),
    activeTabId: state.activeTabId,
  };
}

export function navigatePaneInWorkspace(
  state: WorkspaceState,
  dir: "left" | "right" | "up" | "down",
): WorkspaceState {
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (idx < 0) return state;
  const tab = state.tabs[idx];
  if (tab.zoomed) return state;
  const adjacent = findAdjacent(tab.panes, tab.rootId, tab.activePaneId, dir);
  return adjacent === null ? state : activatePaneInWorkspace(state, adjacent);
}

export function toggleFlipPaneInWorkspace(
  state: WorkspaceState,
  paneId: number,
): WorkspaceState {
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (idx < 0) return state;
  const tab = state.tabs[idx];
  return {
    tabs: replaceTabAtIndex(state.tabs, idx, {
      ...tab,
      panes: toggleFlip(tab.panes, paneId),
    }),
    activeTabId: state.activeTabId,
  };
}

export function updateSplitRatioInWorkspace(
  state: WorkspaceState,
  splitId: number,
  ratio: number,
): WorkspaceState {
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (idx < 0) return state;
  const tab = state.tabs[idx];
  const node = tab.panes[splitId];
  if (!node || node.type !== "split") return state;

  const nextTab: WorkspaceTabState = {
    ...tab,
    panes: {
      ...tab.panes,
      [splitId]: { ...(node as SplitPane), ratio },
    },
  };

  return {
    tabs: replaceTabAtIndex(state.tabs, idx, nextTab),
    activeTabId: state.activeTabId,
  };
}
