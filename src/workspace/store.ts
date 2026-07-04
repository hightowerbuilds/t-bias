import { createSignal, type Accessor } from "solid-js";
import { createStore, produce, type SetStoreFunction } from "solid-js/store";
import {
  closePane as closePaneTree,
  findAdjacent,
  splitPane,
  terminalIds,
  type PaneMap,
  type SplitPane,
  type TerminalPane,
} from "../pane-tree";
import { destroyTerminal, focusTerminal, resetTerminalZoom, zoomTerminal } from "../terminal/session";

export interface Tab {
  id: number;
  rootId: number;
  panes: PaneMap;
  activePaneId: number;
  zoomed: boolean;
  title: string;
  /** Per-pane display titles (process/cwd tracking lands in Phase 3). */
  titles: Record<number, string>;
}

export interface WorkspaceSnapshot {
  tabs: (Tab & { sortOrder: number })[];
  activeTabId: number;
  nextId: number;
}

export interface Workspace {
  tabs: Tab[];
  setTabs: SetStoreFunction<Tab[]>;
  activeTabId: Accessor<number>;
  setActiveTabId: (id: number) => void;
  activeTab: () => Tab | undefined;
  addTab: () => void;
  removeTab: (id: number) => void;
  splitActive: (dir: "h" | "v") => void;
  closeActive: () => void;
  activatePane: (paneId: number) => void;
  navigate: (dir: "left" | "right" | "up" | "down") => void;
  toggleZoom: () => void;
  setRatio: (splitId: number, ratio: number) => void;
  selectTabByIndex: (i: number) => void;
  cycleTab: (delta: number) => void;
  handleShellExit: (paneId: number) => void;
  fontZoom: (delta: number) => void;
  fontZoomReset: () => void;
  hydrate: (snapshot: WorkspaceSnapshot) => void;
  snapshot: () => WorkspaceSnapshot;
}

let counter = 1;
const nextId = () => counter++;

function makeTab(): Tab {
  const paneId = nextId();
  return {
    id: nextId(),
    rootId: paneId,
    panes: { [paneId]: { type: "terminal", id: paneId } as TerminalPane },
    activePaneId: paneId,
    zoomed: false,
    title: "Shell",
    titles: {},
  };
}

export function createWorkspace(): Workspace {
  const [tabs, setTabs] = createStore<Tab[]>([makeTab()]);
  const [activeTabId, setActiveTabId] = createSignal(tabs[0].id);

  const indexOf = (id: number) => tabs.findIndex((t) => t.id === id);
  const activeIndex = () => indexOf(activeTabId());
  const activeTab = () => {
    const i = activeIndex();
    return i >= 0 ? tabs[i] : undefined;
  };

  const activatePane = (paneId: number) => {
    const i = activeIndex();
    if (i < 0) return;
    setTabs(i, "activePaneId", paneId);
    focusTerminal(paneId);
  };

  const addTab = () => {
    const tab = makeTab();
    setTabs(tabs.length, tab);
    setActiveTabId(tab.id);
    queueMicrotask(() => focusTerminal(tab.activePaneId));
  };

  const removeTab = (id: number) => {
    const i = indexOf(id);
    if (i < 0) return;
    for (const pid of terminalIds(tabs[i].panes, tabs[i].rootId)) destroyTerminal(pid);
    const wasActive = id === activeTabId();
    setTabs(produce((list) => list.splice(i, 1)));
    if (tabs.length === 0) {
      const tab = makeTab();
      setTabs([tab]);
      setActiveTabId(tab.id);
    } else if (wasActive) {
      const next = tabs[Math.min(i, tabs.length - 1)];
      setActiveTabId(next.id);
      queueMicrotask(() => focusTerminal(next.activePaneId));
    }
  };

  const splitActive = (dir: "h" | "v") => {
    const i = activeIndex();
    const tab = activeTab();
    if (i < 0 || !tab) return;
    const newLeafId = nextId();
    const result = splitPane(tab.panes, tab.rootId, tab.activePaneId, dir, nextId(), newLeafId);
    setTabs(i, produce((t) => {
      t.panes = result.panes;
      t.rootId = result.rootId;
      t.activePaneId = newLeafId;
      t.zoomed = false;
    }));
    queueMicrotask(() => focusTerminal(newLeafId));
  };

  const closeActive = () => {
    const i = activeIndex();
    const tab = activeTab();
    if (i < 0 || !tab) return;
    // Only-pane tab → close the whole tab.
    if (terminalIds(tab.panes, tab.rootId).length <= 1) {
      removeTab(tab.id);
      return;
    }
    const closing = tab.activePaneId;
    const result = closePaneTree(tab.panes, tab.rootId, closing);
    if (!result.removed) return;
    destroyTerminal(closing);
    setTabs(i, produce((t) => {
      t.panes = result.panes;
      t.rootId = result.rootId;
      t.activePaneId = result.focusId;
      t.zoomed = false;
    }));
    queueMicrotask(() => focusTerminal(result.focusId));
  };

  const handleShellExit = (paneId: number) => {
    // A shell that exited on its own (e.g. `exit`) — collapse its pane.
    const i = tabs.findIndex((t) => t.panes[paneId]?.type === "terminal");
    if (i < 0) return;
    const tab = tabs[i];
    if (terminalIds(tab.panes, tab.rootId).length <= 1) {
      removeTab(tab.id);
      return;
    }
    const result = closePaneTree(tab.panes, tab.rootId, paneId);
    if (!result.removed) return;
    destroyTerminal(paneId);
    setTabs(i, produce((t) => {
      t.panes = result.panes;
      t.rootId = result.rootId;
      if (t.activePaneId === paneId) t.activePaneId = result.focusId;
    }));
  };

  const navigate = (dir: "left" | "right" | "up" | "down") => {
    const tab = activeTab();
    if (!tab || tab.zoomed) return;
    const adj = findAdjacent(tab.panes, tab.rootId, tab.activePaneId, dir);
    if (adj !== null) activatePane(adj);
  };

  const toggleZoom = () => {
    const i = activeIndex();
    if (i < 0) return;
    setTabs(i, "zoomed", (z) => !z);
  };

  const setRatio = (splitId: number, ratio: number) => {
    const i = activeIndex();
    if (i < 0) return;
    setTabs(i, produce((t) => {
      const node = t.panes[splitId];
      if (node?.type === "split") (node as SplitPane).ratio = ratio;
    }));
  };

  const selectTabByIndex = (idx: number) => {
    if (idx >= 0 && idx < tabs.length) {
      setActiveTabId(tabs[idx].id);
      queueMicrotask(() => focusTerminal(tabs[idx].activePaneId));
    }
  };

  const cycleTab = (delta: number) => {
    const i = activeIndex();
    if (i < 0) return;
    const next = (i + delta + tabs.length) % tabs.length;
    setActiveTabId(tabs[next].id);
    queueMicrotask(() => focusTerminal(tabs[next].activePaneId));
  };

  const fontZoom = (delta: number) => {
    const p = activeTab()?.activePaneId;
    if (p != null) zoomTerminal(p, delta);
  };
  const fontZoomReset = () => {
    const p = activeTab()?.activePaneId;
    if (p != null) resetTerminalZoom(p);
  };

  const hydrate = (s: WorkspaceSnapshot) => {
    // Tear down any default tab that was created before hydration.
    for (const tab of tabs) {
      for (const pid of terminalIds(tab.panes, tab.rootId)) destroyTerminal(pid);
    }
    counter = Math.max(counter, s.nextId);
    setTabs(s.tabs);
    setActiveTabId(s.activeTabId);
    queueMicrotask(() => {
      const tab = activeTab();
      if (tab) focusTerminal(tab.activePaneId);
    });
  };

  const snapshot = (): WorkspaceSnapshot => ({
    tabs: tabs.map((tab, i) => ({ ...tab, sortOrder: i })),
    activeTabId: activeTabId(),
    nextId: counter,
  });

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    activeTab,
    addTab,
    removeTab,
    splitActive,
    closeActive,
    activatePane,
    navigate,
    toggleZoom,
    setRatio,
    selectTabByIndex,
    cycleTab,
    handleShellExit,
    fontZoom,
    fontZoomReset,
    hydrate,
    snapshot,
  };
}
