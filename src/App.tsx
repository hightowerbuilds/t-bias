import {
  createSignal,
  For,
  Show,
  onMount,
  onCleanup,
  type Component,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { PanesRoot } from "./Panes";
import PromptStackerView from "./PromptStacker";
import PromptQueueFooter from "./PromptQueueFooter";
import { usePromptStackerStore } from "./promptStackerStore";
import { TabBar } from "./TabBar";
import { ShellLanding } from "./ShellLanding";
import { CloseConfirmDialog, type PendingClose } from "./CloseConfirmDialog";
import {
  useShellRegistry,
  isRestorableShell,
} from "./useShellRegistry";
import {
  findAdjacent,
  terminalIds,
  toggleFlip,
} from "./pane-tree";
import type { SplitPane, EditorPane, TerminalPane } from "./pane-tree";
import {
  CLOSE_PANE_CMD,
  GET_CONFIG_CMD,
  GET_PANE_CWD_CMD,
  WRITE_TO_PTY_CMD,
  SAVE_SESSION_CMD,
  LOAD_SESSION_CMD,
  PREPARE_SHELL_REGISTRY_FOR_LAUNCH_CMD,
  PREPARE_SHELL_REGISTRY_FOR_SHUTDOWN_CMD,
  type AppConfig,
  type SessionData,
  type ShellRecord,
} from "./ipc/types";
import { destroyTerminalHost } from "./Terminal";
import {
  closeActivePaneInWorkspace,
  closeTabInWorkspace,
  dirname,
  makeEditorTab as buildEditorTab,
  makeFileExplorerTab as buildFileExplorerTab,
  makeShellTab as buildShellTab,
  splitActivePaneInWorkspace,
  type ShellTabOptions,
  type WorkspaceTabState,
} from "./workspace-state";
import {
  workspaceToSessionData,
  sessionDataToWorkspace,
} from "./session-state";

const { invoke } = (window as any).__TAURI__.core;

let nextId = 1;
const newId = () => nextId++;

type TabState = WorkspaceTabState;

const makeTab = (input?: string | ShellTabOptions): TabState => buildShellTab(newId, input);
const makeFileExplorerTab = (initialPath?: string): TabState => buildFileExplorerTab(newId, initialPath);
const makeEditorTab = (filePath?: string): TabState => buildEditorTab(newId, filePath);

const App: Component = () => {
  const [config, setConfig] = createSignal<AppConfig | null>(null);
  const [appReady, setAppReady] = createSignal(false);
  const [shellLandingOpen, setShellLandingOpen] = createSignal(false);
  const [promptStackerOpen, setPromptStackerOpen] = createSignal(false);
  const [pendingClose, setPendingClose] = createSignal<PendingClose | null>(null);

  const [tabs, setTabs] = createStore<TabState[]>([]);
  const [activeTabId, setActiveTabId] = createSignal<number>(0);

  const registry = useShellRegistry();

  const tabIdx = () => tabs.findIndex((t) => t.id === activeTabId());
  const tab = () => {
    const idx = tabIdx();
    return idx >= 0 ? tabs[idx] : undefined;
  };

  const displayTitle = (t: TabState, paneId: number) =>
    t.paneProcessTitles[paneId] ?? t.paneTitles[paneId] ?? "Shell";

  const setWorkspaceTabs = (nextTabs: TabState[]) => {
    setTabs(nextTabs);
    setActiveTabId(nextTabs[0]?.id ?? 0);
  };

  // ---------------------------------------------------------------------------
  // Shell landing helpers
  // ---------------------------------------------------------------------------

  const makeTabsFromShellRecords = (records: ShellRecord[]) =>
    records.map((record) =>
      makeTab({
        cwd: record.last_known_cwd ?? undefined,
        shellId: record.id,
        title: record.title || "Shell",
      }));

  const startNewShellWorkspace = () => {
    const freshTab = makeTab();
    setWorkspaceTabs([freshTab]);
    setShellLandingOpen(false);
    setPromptStackerOpen(false);
  };

  const restorePersistedShells = async () => {
    // Prefer session layout over flat shell records.
    const savedSession = (await invoke(LOAD_SESSION_CMD).catch(() => null)) as SessionData | null;
    if (savedSession?.tabs?.length) {
      const { tabs: restoredTabs, activeTabIndex } = sessionDataToWorkspace(savedSession, newId);
      setTabs(restoredTabs);
      setActiveTabId(restoredTabs[activeTabIndex]?.id ?? restoredTabs[0]?.id ?? 0);
    } else {
      const restorable = registry.shellRecords().filter(isRestorableShell);
      if (restorable.length > 0) {
        setWorkspaceTabs(makeTabsFromShellRecords(restorable));
      } else if (!tabs.length) {
        setWorkspaceTabs([makeTab()]);
      }
    }
    setShellLandingOpen(false);
    setPromptStackerOpen(false);
  };

  const openShellLanding = async () => {
    setPromptStackerOpen(false);
    await registry.refreshShellRecords().catch(() => {});
    setShellLandingOpen(true);
  };

  const findOpenShell = (shellId: string) => {
    for (const currentTab of tabs) {
      for (const pane of Object.values(currentTab.panes)) {
        if (pane.type === "terminal" && pane.shellId === shellId) {
          return { tabId: currentTab.id, paneId: pane.id };
        }
      }
    }
    return null;
  };

  const openShellRecord = (record: ShellRecord) => {
    const existing = findOpenShell(record.id);
    if (existing) {
      setActiveTabId(existing.tabId);
      activatePane(existing.paneId);
      setShellLandingOpen(false);
      return;
    }
    const nextTab = makeTab({
      cwd: record.last_known_cwd ?? undefined,
      shellId: record.id,
      title: record.title || "Shell",
    });
    setTabs((prev) => [...prev, nextTab]);
    setActiveTabId(nextTab.id);
    setShellLandingOpen(false);
  };

  // ---------------------------------------------------------------------------
  // Path resolution
  // ---------------------------------------------------------------------------

  const resolveTabPath = async (t?: TabState): Promise<string | undefined> => {
    if (!t) return undefined;
    const trackedPath = t.paneCwds[t.activePaneId];
    if (trackedPath) return trackedPath;
    const activePane = t.panes[t.activePaneId];
    if (activePane?.type === "editor") {
      return activePane.filePath ? dirname(activePane.filePath) : undefined;
    }
    if (activePane?.type === "terminal") {
      try {
        return ((await invoke(GET_PANE_CWD_CMD, { paneId: t.activePaneId })) as string | null) ?? undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const resolveActivePath = async (): Promise<string | undefined> => resolveTabPath(tab());

  // ---------------------------------------------------------------------------
  // Close helpers
  // ---------------------------------------------------------------------------

  const getRunningProcessNames = (targetTabs: TabState[], paneIds?: number[]): string[] => {
    const names: string[] = [];
    for (const t of targetTabs) {
      const ids = paneIds ?? Object.keys(t.paneProcessTitles).map(Number);
      for (const id of ids) {
        const name = t.paneProcessTitles[id];
        if (name) names.push(name);
      }
    }
    return [...new Set(names)];
  };

  const getTerminalShellIdsForPaneIds = (t: TabState | undefined, paneIds: number[]) => {
    if (!t) return [];
    const shellIds = new Set<string>();
    for (const paneId of paneIds) {
      const pane = t.panes[paneId];
      if (pane?.type === "terminal" && pane.shellId) {
        shellIds.add(pane.shellId);
      }
    }
    return [...shellIds];
  };

  const closeTerminalPanesForTab = async (t?: TabState) => {
    if (!t) return;
    await Promise.all(
      terminalIds(t.panes, t.rootId).map((paneId) =>
        invoke(CLOSE_PANE_CMD, { paneId }).catch(() => {}),
      ),
    );
  };

  // ---------------------------------------------------------------------------
  // Tab / pane actions
  // ---------------------------------------------------------------------------

  const openFileInEditor = (filePath: string) => {
    const nextTab = makeEditorTab(filePath);
    setTabs((prev) => [...prev, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const addTab = async () => {
    const cwd = await resolveActivePath();
    const nextTab = makeTab(cwd);
    setTabs((prev) => [...prev, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const addFileExplorerTab = async () => {
    const initialPath = await resolveActivePath();
    const nextTab = makeFileExplorerTab(initialPath);
    setTabs((prev) => [...prev, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const doRemoveTab = async (id: number) => {
    const idx = tabs.findIndex((t) => t.id === id);
    const closingTab = idx >= 0 ? tabs[idx] : undefined;
    if (idx < 0) return;
    const replacementPath = tabs.length === 1 ? await resolveTabPath(closingTab) : undefined;
    const result = closeTabInWorkspace(
      { tabs: tabs.slice(), activeTabId: activeTabId() },
      id,
      makeTab,
      replacementPath,
    );
    const closingPaneIds = terminalIds(closingTab!.panes, closingTab!.rootId);
    await registry.closeShellRecords(getTerminalShellIdsForPaneIds(closingTab, closingPaneIds));
    await closeTerminalPanesForTab(closingTab);
    closingPaneIds.forEach(destroyTerminalHost);
    setTabs(result.tabs);
    setActiveTabId(result.activeTabId);
  };

  const removeTab = async (id: number) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const closingTab = tabs[idx];
    const running = getRunningProcessNames([closingTab]);
    if (running.length > 0) {
      setPendingClose({ processNames: running, onConfirm: () => void doRemoveTab(id) });
      return;
    }
    await doRemoveTab(id);
  };

  const splitActivePane = (dir: "h" | "v") => {
    const currentTab = tab();
    if (!currentTab) return;
    const result = splitActivePaneInWorkspace(
      { tabs: tabs.slice(), activeTabId: activeTabId() },
      dir,
      newId,
    );
    setTabs(result.tabs);
  };

  const doCloseActivePane = async () => {
    const currentTab = tab();
    if (!currentTab) return;
    const replacementPath = await resolveTabPath(currentTab);
    const result = closeActivePaneInWorkspace(
      { tabs: tabs.slice(), activeTabId: activeTabId() },
      makeTab,
      replacementPath,
    );
    const shellIds = getTerminalShellIdsForPaneIds(currentTab, result.closeTerminalPaneIds);
    await registry.closeShellRecords(shellIds);
    await Promise.all(
      result.closeTerminalPaneIds.map((paneId) =>
        invoke(CLOSE_PANE_CMD, { paneId }).catch(() => {}),
      ),
    );
    result.closeTerminalPaneIds.forEach(destroyTerminalHost);
    setTabs(result.tabs);
    setActiveTabId(result.activeTabId);
  };

  const closeActivePane = async () => {
    const currentTab = tab();
    if (!currentTab) return;
    const running = getRunningProcessNames([currentTab], [currentTab.activePaneId]);
    if (running.length > 0) {
      setPendingClose({ processNames: running, onConfirm: () => void doCloseActivePane() });
      return;
    }
    await doCloseActivePane();
  };

  const activatePane = (paneId: number) => {
    const idx = tabIdx();
    if (idx < 0) return;
    setTabs(idx, produce((draft) => {
      draft.activePaneId = paneId;
      draft.title = displayTitle(draft, paneId);
      draft.hasActivity = false;
    }));
  };

  const navigatePane = (dir: "left" | "right" | "up" | "down") => {
    const currentTab = tab();
    if (!currentTab || currentTab.zoomed) return;
    const adjacent = findAdjacent(currentTab.panes, currentTab.rootId, currentTab.activePaneId, dir);
    if (adjacent !== null) activatePane(adjacent);
  };

  const toggleFlipPane = (paneId: number) => {
    const idx = tabIdx();
    const currentTab = tab();
    if (idx < 0 || !currentTab) return;
    setTabs(idx, "panes", toggleFlip(currentTab.panes, paneId));
  };

  const toggleZoom = () => {
    const idx = tabIdx();
    if (idx < 0) return;
    setTabs(idx, "zoomed", (zoomed) => !zoomed);
  };

  // ---------------------------------------------------------------------------
  // Pane event handlers
  // ---------------------------------------------------------------------------

  const handleRatioChange = (splitId: number, ratio: number) => {
    const idx = tabIdx();
    if (idx < 0) return;
    setTabs(idx, produce((draft) => {
      const node = draft.panes[splitId];
      if (node?.type === "split") {
        (node as SplitPane).ratio = ratio;
      }
    }));
  };

  const handleTitleChange = (tabId: number, paneId: number, title: string) => {
    const idx = tabs.findIndex((currentTab) => currentTab.id === tabId);
    if (idx < 0) return;
    const shellId = tabs[idx].panes[paneId]?.type === "terminal"
      ? (tabs[idx].panes[paneId] as TerminalPane).shellId
      : undefined;
    let nextTitle = title;
    setTabs(idx, produce((draft) => {
      draft.paneTitles[paneId] = title;
      nextTitle = displayTitle(draft, paneId);
      if (draft.activePaneId === paneId && !draft.paneProcessTitles[paneId]) {
        draft.title = nextTitle;
      }
    }));
    if (shellId) {
      void registry.syncShellRecord(shellId, { title: nextTitle });
    }
  };

  const handleProcessTitleChange = (tabId: number, paneId: number, title: string | null) => {
    const idx = tabs.findIndex((currentTab) => currentTab.id === tabId);
    if (idx < 0) return;
    const shellId = tabs[idx].panes[paneId]?.type === "terminal"
      ? (tabs[idx].panes[paneId] as TerminalPane).shellId
      : undefined;
    let nextTitle = tabs[idx].paneTitles[paneId] ?? "Shell";
    setTabs(idx, produce((draft) => {
      if (title) {
        draft.paneProcessTitles[paneId] = title;
      } else {
        delete draft.paneProcessTitles[paneId];
      }
      nextTitle = displayTitle(draft, paneId);
      if (draft.activePaneId === paneId) {
        draft.title = nextTitle;
      }
    }));
    if (shellId) {
      void registry.syncShellRecord(shellId, { title: nextTitle });
    }
  };

  const handleCwdChange = (tabId: number, paneId: number, cwd: string) => {
    const idx = tabs.findIndex((currentTab) => currentTab.id === tabId);
    if (idx < 0) return;
    const pane = tabs[idx].panes[paneId];
    if (tabs[idx].paneCwds[paneId] === cwd) return;
    const shellId = pane?.type === "terminal" ? pane.shellId : undefined;
    setTabs(idx, produce((draft) => {
      draft.paneCwds[paneId] = cwd;
      const nextPane = draft.panes[paneId];
      if (nextPane?.type === "terminal") {
        nextPane.cwd = cwd;
      }
    }));
    if (shellId) {
      void registry.syncShellRecord(shellId, { cwd });
    }
  };

  const handleShellRecordReady = (tabId: number, paneId: number, record: ShellRecord) => {
    const idx = tabs.findIndex((currentTab) => currentTab.id === tabId);
    if (idx < 0) return;
    setTabs(idx, produce((draft) => {
      const pane = draft.panes[paneId];
      if (pane?.type !== "terminal") return;
      pane.shellId = record.id;
      if (record.last_known_cwd) {
        pane.cwd = record.last_known_cwd;
        draft.paneCwds[paneId] = record.last_known_cwd;
      }
      if (!draft.paneProcessTitles[paneId]) {
        draft.paneTitles[paneId] = record.title || draft.paneTitles[paneId] || "Shell";
      }
      if (draft.activePaneId === paneId) {
        draft.title = displayTitle(draft, paneId);
      }
    }));
    registry.applyShellRecord(record);
  };

  const handleShellExit = (tabId: number, paneId: number) => {
    const idx = tabs.findIndex((currentTab) => currentTab.id === tabId);
    if (idx < 0) return;
    const pane = tabs[idx].panes[paneId];
    if (pane?.type !== "terminal" || !pane.shellId) return;
    void registry.closeShellRecordById(pane.shellId);
    setTabs(idx, produce((draft) => {
      delete draft.paneProcessTitles[paneId];
      if (draft.activePaneId === paneId) {
        draft.title = displayTitle(draft, paneId);
      }
    }));
  };

  const handleActivity = (tabId: number, paneId: number) => {
    const idx = tabs.findIndex((currentTab) => currentTab.id === tabId);
    if (idx < 0) return;
    const currentTab = tabs[idx];
    if (tabId !== activeTabId() || currentTab.activePaneId !== paneId) {
      setTabs(idx, "hasActivity", true);
    }
  };

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  /** Match a KeyboardEvent against a keybinding string like "Cmd+Shift+D". */
  const matchKb = (e: KeyboardEvent, binding: string): boolean => {
    const parts = binding.toLowerCase().split("+");
    const wantMeta = parts.includes("cmd") || parts.includes("meta");
    const wantShift = parts.includes("shift");
    const wantAlt = parts.includes("alt") || parts.includes("option");
    const wantCtrl = parts.includes("ctrl");
    const keyPart = parts.filter(p => !["cmd","meta","shift","alt","option","ctrl"].includes(p))[0] ?? "";
    if (wantMeta !== e.metaKey) return false;
    if (wantShift !== e.shiftKey) return false;
    if (wantAlt !== e.altKey) return false;
    if (wantCtrl !== e.ctrlKey) return false;
    if (keyPart === "enter") return e.key === "Enter";
    if (keyPart === "/") return e.key === "/";
    return e.key.toLowerCase() === keyPart;
  };

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (promptStackerOpen()) {
      if (e.key === "Escape") { e.preventDefault(); setPromptStackerOpen(false); }
      return;
    }
    if (shellLandingOpen()) {
      if (e.key === "Escape" && tabs.length > 0) { e.preventDefault(); setShellLandingOpen(false); }
      return;
    }
    if (!appReady() || !e.metaKey) return;
    const kb = config()!.keybindings;

    if (matchKb(e, kb.new_tab)) { e.preventDefault(); e.stopPropagation(); void addTab(); return; }
    if (matchKb(e, kb.close)) { e.preventDefault(); e.stopPropagation(); void closeActivePane(); return; }
    if (matchKb(e, kb.split_horizontal)) { e.preventDefault(); e.stopPropagation(); splitActivePane("h"); return; }
    if (matchKb(e, kb.split_vertical)) { e.preventDefault(); e.stopPropagation(); splitActivePane("v"); return; }
    if (matchKb(e, kb.zoom)) { e.preventDefault(); e.stopPropagation(); toggleZoom(); return; }
    if (matchKb(e, kb.flip)) {
      e.preventDefault(); e.stopPropagation();
      const currentTab = tab();
      if (currentTab) toggleFlipPane(currentTab.activePaneId);
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "e" && e.shiftKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); void addFileExplorerTab(); return; }

    if (matchKb(e, kb.advance_queue)) {
      e.preventDefault(); e.stopPropagation();
      const queueStore = usePromptStackerStore();
      void (async () => {
        const text = await queueStore.advanceQueue();
        if (!text) return;
        const currentTab = tab();
        if (currentTab && currentTab.panes[currentTab.activePaneId]?.type === "terminal") {
          await invoke(WRITE_TO_PTY_CMD, { paneId: currentTab.activePaneId, data: text }).catch(() => {});
        } else {
          await navigator.clipboard.writeText(text).catch(() => {});
        }
      })();
      return;
    }

    const digit = parseInt(e.key, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
      if (digit - 1 < tabs.length) { e.preventDefault(); e.stopPropagation(); setActiveTabId(tabs[digit - 1].id); }
      return;
    }
    if (e.code === "BracketLeft" && e.shiftKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const idx = tabs.findIndex((ct) => ct.id === activeTabId());
      if (idx > 0) setActiveTabId(tabs[idx - 1].id);
      return;
    }
    if (e.code === "BracketRight" && e.shiftKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const idx = tabs.findIndex((ct) => ct.id === activeTabId());
      if (idx >= 0 && idx < tabs.length - 1) setActiveTabId(tabs[idx + 1].id);
      return;
    }
    if (e.altKey && !e.shiftKey) {
      const dirs: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
      };
      const dir = dirs[e.key];
      if (dir) { e.preventDefault(); e.stopPropagation(); navigatePane(dir); }
    }
  };

  // ---------------------------------------------------------------------------
  // App lifecycle
  // ---------------------------------------------------------------------------

  const shutdownShellRegistry = async () => {
    // Save the full workspace layout so it can be restored on next launch.
    const sessionData = workspaceToSessionData(tabs.slice(), activeTabId());
    await invoke(SAVE_SESSION_CMD, { data: sessionData }).catch(() => {});

    const activeShellIds = [...new Set(
      tabs.flatMap((currentTab) =>
        Object.values(currentTab.panes)
          .filter((pane): pane is TerminalPane => pane.type === "terminal")
          .map((pane) => pane.shellId)
          .filter((shellId): shellId is string => Boolean(shellId)),
      ),
    )];
    await invoke(PREPARE_SHELL_REGISTRY_FOR_SHUTDOWN_CMD, { activeShellIds }).catch(() => {});
  };

  let appWindow: any;
  let unlistenClose: (() => void) | undefined;
  let unlistenFileExplorer: (() => void) | undefined;
  let unlistenCodeEditor: (() => void) | undefined;
  let unlistenConfigChanged: (() => void) | undefined;

  onMount(async () => {
    const cfg = (await invoke(GET_CONFIG_CMD)) as AppConfig;
    const prepared = ((await invoke(PREPARE_SHELL_REGISTRY_FOR_LAUNCH_CMD).catch(() => [])) as ShellRecord[]) ?? [];
    registry.initializeRecords(prepared);
    const restorable = prepared.filter(isRestorableShell);

    setConfig(cfg);

    // Apply window opacity from config.
    if (cfg.opacity < 1.0) {
      const { getCurrentWindow } = (window as any).__TAURI__.window;
      getCurrentWindow().setAlwaysOnTop(false).catch(() => {});
      // Tauri v2: use the alpha channel on the window background.
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
    }

    // Try to restore the full workspace layout from session.json first.
    // Fall back to flat shell-record tabs if no layout exists.
    const savedSession = (await invoke(LOAD_SESSION_CMD).catch(() => null)) as SessionData | null;
    const hasLayout = savedSession?.tabs?.length != null && savedSession.tabs.length > 0;

    if (cfg.shells.restore === "always") {
      if (hasLayout) {
        const { tabs: restoredTabs, activeTabIndex } = sessionDataToWorkspace(savedSession!, newId);
        setTabs(restoredTabs);
        setActiveTabId(restoredTabs[activeTabIndex]?.id ?? restoredTabs[0]?.id ?? 0);
      } else if (restorable.length > 0) {
        setWorkspaceTabs(makeTabsFromShellRecords(restorable));
      } else {
        setWorkspaceTabs([makeTab()]);
      }
    } else if (cfg.shells.restore === "ask" && (hasLayout || restorable.length > 0)) {
      setShellLandingOpen(true);
    } else {
      setWorkspaceTabs([makeTab()]);
    }

    setAppReady(true);

    window.addEventListener("keydown", handleGlobalKeyDown, { capture: true });

    // Use Tauri's onCloseRequested so we can properly await shell registry
    // shutdown before the window closes. The backend RunEvent::Exit handler
    // guarantees PTY process cleanup independently.
    const { getCurrentWindow } = (window as any).__TAURI__.window;
    appWindow = getCurrentWindow();
    unlistenClose = await appWindow.onCloseRequested(async (event: any) => {
      event.preventDefault();
      const running = getRunningProcessNames(tabs.slice());
      if (running.length > 0) {
        setPendingClose({
          processNames: running,
          onConfirm: async () => {
            setPendingClose(null);
            await shutdownShellRegistry();
            await appWindow.destroy();
          },
        });
        return;
      }
      await shutdownShellRegistry();
      await appWindow.destroy();
    });

    const { listen } = (window as any).__TAURI__.event;
    unlistenFileExplorer = await listen("open-file-explorer", () => {
      void addFileExplorerTab();
    });
    unlistenCodeEditor = await listen("open-code-editor", () => {
      const nextTab = makeEditorTab();
      setTabs((prev) => [...prev, nextTab]);
      setActiveTabId(nextTab.id);
    });

    // Config hot-reload — backend polls the config file and emits on change.
    unlistenConfigChanged = await listen("config-changed", (event: any) => {
      const nextCfg = event.payload as AppConfig;
      if (nextCfg) setConfig(nextCfg);
    });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
    unlistenClose?.();
    unlistenFileExplorer?.();
    unlistenCodeEditor?.();
    unlistenConfigChanged?.();
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Show when={config() && appReady()}>
      <div style={{ display: "flex", "flex-direction": "column", width: "100%", height: "100%" }}>
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={(id) => void removeTab(id)}
          onNewTab={() => void addTab()}
          onFlip={() => {
            const currentTab = tab();
            if (currentTab) toggleFlipPane(currentTab.activePaneId);
          }}
          onOpenShells={() => void openShellLanding()}
          onOpenStacker={() => { setShellLandingOpen(false); setPromptStackerOpen(true); }}
        />

        <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
          <For each={tabs}>
            {(currentTab) => (
              <div style={{
                position: "absolute",
                inset: "0",
                visibility: currentTab.id === activeTabId() ? "visible" : "hidden",
                "pointer-events": currentTab.id === activeTabId() ? "auto" : "none",
              }}>
                <PanesRoot
                  rootId={currentTab.rootId}
                  panes={currentTab.panes}
                  activePaneId={currentTab.activePaneId}
                  config={config()!}
                  zoomed={currentTab.zoomed}
                  paneTitles={currentTab.paneTitles}
                  paneCwds={currentTab.paneCwds}
                  onActivate={activatePane}
                  onTitleChange={(paneId, title) => handleTitleChange(currentTab.id, paneId, title)}
                  onProcessTitleChange={(paneId, title) => handleProcessTitleChange(currentTab.id, paneId, title)}
                  onCwdChange={(paneId, cwd) => handleCwdChange(currentTab.id, paneId, cwd)}
                  onShellRecordReady={(paneId, record) => handleShellRecordReady(currentTab.id, paneId, record)}
                  onShellExit={(paneId) => handleShellExit(currentTab.id, paneId)}
                  onActivity={(paneId) => handleActivity(currentTab.id, paneId)}
                  onRatioChange={handleRatioChange}
                  onFlip={toggleFlipPane}
                  onOpenFile={openFileInEditor}
                />
              </div>
            )}
          </For>
        </div>

        <PromptQueueFooter
          config={config()!}
          activePaneId={tab()?.activePaneId}
          activeIsTerminal={tab()?.panes[tab()!.activePaneId]?.type === "terminal"}
        />

        <Show when={promptStackerOpen()}>
          <div
            style={{
              position: "fixed",
              inset: "0",
              background: "var(--bg-overlay)",
              display: "flex",
              "flex-direction": "column",
              "z-index": "var(--z-stacker-modal)",
              "min-height": "0",
            }}
          >
            <PromptStackerView
              config={config()!}
              isActive={promptStackerOpen()}
              shouldFocus={promptStackerOpen()}
              variant="modal"
              onClose={() => setPromptStackerOpen(false)}
            />
          </div>
        </Show>

        <Show when={shellLandingOpen()}>
          <div
            style={{
              position: "fixed",
              inset: "0",
              background: "var(--bg-overlay)",
              display: "flex",
              "flex-direction": "column",
              "z-index": "var(--z-shell-landing)",
              "min-height": "0",
            }}
          >
            <ShellLanding
              records={registry.shellRecords()}
              hasTabs={tabs.length > 0}
              findOpenShell={findOpenShell}
              onOpenRecord={openShellRecord}
              onTogglePersist={(id, persist) => void registry.setShellPersistOnQuit(id, persist)}
              onRestoreAll={restorePersistedShells}
              onNewShell={startNewShellWorkspace}
              onClose={() => setShellLandingOpen(false)}
            />
          </div>
        </Show>

        <CloseConfirmDialog
          pending={pendingClose()}
          onDismiss={() => setPendingClose(null)}
        />
      </div>
    </Show>
  );
};

export default App;
