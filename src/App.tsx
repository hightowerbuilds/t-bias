import {
  createSignal,
  For,
  Match,
  Show,
  Switch,
  onMount,
  onCleanup,
  type Component,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { PanesRoot } from "./Panes";
import PromptStackerView from "./PromptStacker";
import {
  splitPane,
  closePane,
  leafIds,
  findAdjacent,
  toggleFlip,
  type PaneMap,
} from "./pane-tree";
import type { SplitPane, EditorPane } from "./pane-tree";
import {
  GET_CONFIG_CMD,
  GET_PANE_CWD_CMD,
  SAVE_SESSION_CMD,
  LOAD_SESSION_CMD,
  SAVE_NAMED_SESSION_CMD,
  LOAD_NAMED_SESSION_CMD,
  LIST_NAMED_SESSIONS_CMD,
  DELETE_NAMED_SESSION_CMD,
  type AppConfig,
  type SessionData,
} from "./ipc/types";
import { savedTabToTabState, tabToSavedTab } from "./session-state";

const { invoke } = (window as any).__TAURI__.core;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let nextId = 1;
const newId = () => nextId++;

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

interface TabState {
  id: number;
  title: string;
  hasActivity: boolean;
  returnTabId?: number;
  rootId: number;
  activePaneId: number;
  panes: PaneMap;
  paneTitles: Record<number, string>;
  paneProcessTitles: Record<number, string>;
  paneCwds: Record<number, string>;
  zoomed: boolean;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function makeTab(cwd?: string): TabState {
  const paneId = newId();
  return {
    id: newId(),
    title: "Shell",
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "terminal", id: paneId, cwd } },
    paneTitles: { [paneId]: "Shell" },
    paneProcessTitles: {},
    paneCwds: cwd ? { [paneId]: cwd } : {},
    zoomed: false,
  };
}

function makeFileExplorerTab(initialPath?: string): TabState {
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

function makePromptStackerTab(returnTabId?: number): TabState {
  const paneId = newId();
  return {
    id: newId(),
    title: "Prompt Stacker",
    hasActivity: false,
    returnTabId,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "prompt-stacker", id: paneId } },
    paneTitles: { [paneId]: "Prompt Stacker" },
    paneProcessTitles: {},
    paneCwds: {},
    zoomed: false,
  };
}

function makeEditorTab(filePath?: string): TabState {
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

const TAB_BAR_H = 30;
const SESSION_SAVE_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const App: Component = () => {
  const [config, setConfig] = createSignal<AppConfig | null>(null);
  const [appReady, setAppReady] = createSignal(false);

  // Session state
  const [pendingRestore, setPendingRestore] = createSignal<SessionData | null>(null);
  const [namedSessions, setNamedSessions] = createSignal<string[]>([]);
  const [sessionsMenuOpen, setSessionsMenuOpen] = createSignal(false);
  const [saveNameValue, setSaveNameValue] = createSignal<string | null>(null);
  const [promptStackerOpen, setPromptStackerOpen] = createSignal(false);

  // Tab store
  const [tabs, setTabs] = createStore<TabState[]>([makeTab()]);
  const [activeTabId, setActiveTabId] = createSignal<number>(tabs[0].id);
  let sessionSaveTimer: number | undefined;

  const tabIdx = () => tabs.findIndex((t) => t.id === activeTabId());
  const tab = () => tabs[tabIdx()];
  const displayTitle = (t: TabState, paneId: number) =>
    t.paneProcessTitles[paneId] ?? t.paneTitles[paneId] ?? "Shell";
  // ── Session: build + restore ─────────────────────────────────────────────

  const resolveTrackedPaneCwdsForTab = async (t: TabState): Promise<Record<number, string>> => {
    const next = { ...t.paneCwds };
    const terminals = Object.values(t.panes).filter((pane) => pane.type === "terminal");

    await Promise.all(terminals.map(async (pane) => {
      if (next[pane.id]) return;
      try {
        const cwd = ((await invoke(GET_PANE_CWD_CMD, { paneId: pane.id })) as string | null) ?? undefined;
        if (cwd) next[pane.id] = cwd;
      } catch {
        // Ignore panes that cannot currently report cwd.
      }
    }));

    return next;
  };

  const buildSessionData = async (): Promise<SessionData> => {
    const hydratedTabs = await Promise.all(
      tabs.map(async (t) => ({
        ...t,
        paneCwds: await resolveTrackedPaneCwdsForTab(t),
      })),
    );

    return {
      version: 1,
      activeTabIndex: Math.max(0, tabIdx()),
      tabs: hydratedTabs.map(tabToSavedTab),
    };
  };

  const cancelScheduledSessionSave = () => {
    if (sessionSaveTimer !== undefined) {
      window.clearTimeout(sessionSaveTimer);
      sessionSaveTimer = undefined;
    }
  };

  const applySession = (data: SessionData) => {
    cancelScheduledSessionSave();
    if (!data.tabs?.length) return;
    const restored = data.tabs.map((saved) => savedTabToTabState(saved, newId));
    setTabs(restored);
    const idx = Math.min(data.activeTabIndex ?? 0, restored.length - 1);
    setActiveTabId(restored[idx].id);
    setPromptStackerOpen(false);
  };

  const saveSession = async () => {
    const data = await buildSessionData();
    await invoke(SAVE_SESSION_CMD, { data }).catch(() => {});
  };

  const scheduleSessionSave = () => {
    if (!appReady()) return;
    cancelScheduledSessionSave();
    sessionSaveTimer = window.setTimeout(() => {
      sessionSaveTimer = undefined;
      void saveSession();
    }, SESSION_SAVE_DEBOUNCE_MS);
  };

  const flushSessionSave = async () => {
    cancelScheduledSessionSave();
    if (!appReady()) return;
    await saveSession();
  };

  const handleBeforeUnload = () => {
    void flushSessionSave();
  };

  const refreshNamedSessions = async () => {
    const names = (await invoke(LIST_NAMED_SESSIONS_CMD)) as string[];
    setNamedSessions(names);
  };

  const startNewSession = () => {
    cancelScheduledSessionSave();
    const freshTab = makeTab();
    setTabs([freshTab]);
    setActiveTabId(freshTab.id);
    setPendingRestore(null);
    setPromptStackerOpen(false);
    setSessionsMenuOpen(false);
    setSaveNameValue(null);
    setAppReady(true);
  };

  const resumePendingSession = () => {
    const data = pendingRestore();
    if (!data?.tabs?.length) return;
    applySession(data);
    setPendingRestore(null);
    setPromptStackerOpen(false);
    setSessionsMenuOpen(false);
    setSaveNameValue(null);
    setAppReady(true);
  };

  const openSessionLanding = async () => {
    const snapshot = await buildSessionData();
    await invoke(SAVE_SESSION_CMD, { data: snapshot }).catch(() => {});
    setPendingRestore(snapshot);
    setPromptStackerOpen(false);
    setSessionsMenuOpen(false);
    setSaveNameValue(null);
    await refreshNamedSessions().catch(() => {});
    setAppReady(false);
  };

  const openPromptStacker = () => {
    setSessionsMenuOpen(false);
    setSaveNameValue(null);
    setPromptStackerOpen(true);
  };

  const closePromptStacker = () => {
    setPromptStackerOpen(false);
  };

  const resolveTabPath = async (t?: TabState): Promise<string | undefined> => {
    if (!t) return undefined;

    const activePane = t.panes[t.activePaneId];
    const trackedPath = t.paneCwds[t.activePaneId];
    if (trackedPath) return trackedPath;

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

  // ── Open file in editor (called from file explorer) ──────────────────────

  const openFileInEditor = (filePath: string) => {
    const t = makeEditorTab(filePath);
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    scheduleSessionSave();
  };

  // ── Tab operations ────────────────────────────────────────────────────────

  const addTab = async () => {
    const cwd = await resolveActivePath();
    const t = makeTab(cwd);
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    scheduleSessionSave();
  };

  const addFileExplorerTab = async () => {
    const initialPath = await resolveActivePath();
    const t = makeFileExplorerTab(initialPath);
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    scheduleSessionSave();
  };

  const addPromptStackerTab = () => {
    openPromptStacker();
  };

  const switchTab = (id: number) => {
    setActiveTabId(id);
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx >= 0) setTabs(idx, "hasActivity", false);
    scheduleSessionSave();
  };

  const removeTab = (id: number) => {
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (id === activeTabId()) {
      const next = idx > 0 ? tabs[idx - 1] : tabs[idx + 1];
      setActiveTabId(next.id);
    }
    setTabs((prev) => prev.filter((t) => t.id !== id));
    scheduleSessionSave();
  };

  // ── Pane operations ───────────────────────────────────────────────────────

  const splitActivePane = (dir: "h" | "v") => {
    const t = tab();
    if (!t || t.zoomed) return;
    const splitId = newId();
    const newLeafId = newId();
    const { panes: newPanes, rootId: newRootId } = splitPane(
      t.panes, t.rootId, t.activePaneId, dir, splitId, newLeafId,
    );
    setTabs(tabIdx(), produce((d) => {
      d.panes = newPanes;
      d.rootId = newRootId;
      d.activePaneId = newLeafId;
      d.paneTitles[newLeafId] = "Shell";
      delete d.paneProcessTitles[newLeafId];
    }));
    scheduleSessionSave();
  };

  const closeActivePane = () => {
    const t = tab();
    if (!t) return;
    if (leafIds(t.panes, t.rootId).length <= 1) {
      removeTab(t.id);
      return;
    }
    if (t.zoomed) { setTabs(tabIdx(), "zoomed", false); return; }
    const { panes: newPanes, rootId: newRootId, focusId } = closePane(
      t.panes, t.rootId, t.activePaneId,
    );
    setTabs(tabIdx(), produce((d) => {
      d.panes = newPanes;
      d.rootId = newRootId;
      d.activePaneId = focusId;
      d.title = displayTitle(d, focusId);
      delete d.paneTitles[t.activePaneId];
      delete d.paneProcessTitles[t.activePaneId];
    }));
    scheduleSessionSave();
  };

  const activatePane = (paneId: number) => {
    setTabs(tabIdx(), produce((d) => {
      d.activePaneId = paneId;
      d.title = displayTitle(d, paneId);
      d.hasActivity = false;
    }));
  };

  const navigatePane = (dir: "left" | "right" | "up" | "down") => {
    const t = tab();
    if (!t || t.zoomed) return;
    const adj = findAdjacent(t.panes, t.rootId, t.activePaneId, dir);
    if (adj !== null) activatePane(adj);
  };

  const toggleFlipPane = (paneId: number) => {
    const idx = tabIdx();
    const t = tab();
    if (!t) return;
    const newPanes = toggleFlip(t.panes, paneId);
    setTabs(idx, "panes", newPanes);
  };

  const toggleZoom = () => setTabs(tabIdx(), "zoomed", (z) => !z);

  const handleRatioChange = (splitId: number, ratio: number) => {
    const idx = tabIdx();
    // Use produce to update the nested ratio field.
    setTabs(idx, produce((d) => {
      const node = d.panes[splitId];
      if (node?.type === "split") (node as SplitPane).ratio = ratio;
    }));
  };

  const handleTitleChange = (tabId: number, paneId: number, title: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    setTabs(idx, produce((d) => {
      d.paneTitles[paneId] = title;
      if (d.activePaneId === paneId && !d.paneProcessTitles[paneId]) {
        d.title = title;
      }
    }));
  };

  const handleProcessTitleChange = (tabId: number, paneId: number, title: string | null) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    setTabs(idx, produce((d) => {
      if (title) d.paneProcessTitles[paneId] = title;
      else delete d.paneProcessTitles[paneId];
      if (d.activePaneId === paneId) d.title = displayTitle(d, paneId);
    }));
  };

  const handleCwdChange = (tabId: number, paneId: number, cwd: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    if (tabs[idx].paneCwds[paneId] === cwd) return;
    setTabs(idx, produce((d) => {
      d.paneCwds[paneId] = cwd;
    }));
    scheduleSessionSave();
  };

  const handleActivity = (tabId: number, paneId: number) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const t = tabs[idx];
    if (tabId !== activeTabId() || t.activePaneId !== paneId) {
      setTabs(idx, "hasActivity", true);
    }
  };

  // ── Named sessions ────────────────────────────────────────────────────────

  const openSessionsMenu = async () => {
    await refreshNamedSessions();
    setSessionsMenuOpen(true);
  };

  const saveNamedSession = async (name: string) => {
    if (!name.trim()) return;
    const data = await buildSessionData();
    await invoke(SAVE_NAMED_SESSION_CMD, { name: name.trim(), data });
    setSaveNameValue(null);
    await refreshNamedSessions();
  };

  const loadNamedSession = async (name: string) => {
    const data = (await invoke(LOAD_NAMED_SESSION_CMD, { name })) as SessionData | null;
    if (data?.tabs?.length) {
      applySession(data);
      setPendingRestore(null);
      setPromptStackerOpen(false);
      setAppReady(true);
    }
    setSessionsMenuOpen(false);
  };

  const deleteNamedSession = async (name: string) => {
    await invoke(DELETE_NAMED_SESSION_CMD, { name });
    await refreshNamedSessions();
  };

  // ── Global keyboard shortcuts ─────────────────────────────────────────────

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (promptStackerOpen()) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePromptStacker();
      }
      return;
    }
    if (!appReady()) return;
    if (!e.metaKey) return;
    const key = e.key.toLowerCase();

    if (key === "t" && !e.shiftKey && !e.altKey) { e.preventDefault(); addTab(); return; }
    if (key === "w" && !e.shiftKey && !e.altKey) { e.preventDefault(); closeActivePane(); return; }
    if (key === "d" && !e.shiftKey && !e.altKey) { e.preventDefault(); splitActivePane("h"); return; }
    if (key === "d" && e.shiftKey && !e.altKey)  { e.preventDefault(); splitActivePane("v"); return; }

    if (e.key === "Enter" && e.shiftKey && !e.altKey) { e.preventDefault(); toggleZoom(); return; }

    // Cmd+/ — flip terminal to file explorer
    if (e.key === "/" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const t = tab();
      if (t) toggleFlipPane(t.activePaneId);
      return;
    }

    // Cmd+Shift+E — file explorer
    if (key === "e" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      addFileExplorerTab();
      return;
    }

    // Cmd+Shift+S — save named session
    if (key === "s" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      setSaveNameValue("");
      setSessionsMenuOpen(true);
      refreshNamedSessions();
      return;
    }

    const digit = parseInt(e.key, 10);
    if (!isNaN(digit) && digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
      if (digit - 1 < tabs.length) { e.preventDefault(); switchTab(tabs[digit - 1].id); }
      return;
    }

    if (e.code === "BracketLeft"  && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeTabId());
      if (idx > 0) switchTab(tabs[idx - 1].id);
      return;
    }
    if (e.code === "BracketRight" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeTabId());
      if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
      return;
    }

    if (e.altKey && !e.shiftKey) {
      const dirs: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
      };
      const dir = dirs[e.key];
      if (dir) { e.preventDefault(); navigatePane(dir); return; }
    }
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  let unlistenFileExplorer: (() => void) | undefined;
  let unlistenCodeEditor: (() => void) | undefined;

  onMount(async () => {
    const cfg = (await invoke(GET_CONFIG_CMD)) as AppConfig;
    const saved = (await invoke(LOAD_SESSION_CMD).catch(() => null)) as SessionData | null;

    const mode = cfg.session?.restore ?? "ask";

    if (saved?.tabs?.length) {
      if (mode === "always") {
        applySession(saved);
        setConfig(cfg);
        setAppReady(true);
      } else if (mode === "ask") {
        setConfig(cfg);
        setPendingRestore(saved); // show prompt; don't set appReady yet
        await refreshNamedSessions().catch(() => {});
      } else {
        // "never"
        setConfig(cfg);
        setAppReady(true);
      }
    } else {
      setConfig(cfg);
      setAppReady(true);
    }

    if (mode !== "ask") {
      void refreshNamedSessions().catch(() => {});
    }

    window.addEventListener("keydown", handleGlobalKeyDown, { capture: true });

    // Best-effort save when the page is unloaded.
    window.addEventListener("beforeunload", handleBeforeUnload);

    // Native menu bar events — "View > File Explorer" and "View > Code Editor"
    const { listen } = (window as any).__TAURI__.event;
    unlistenFileExplorer = await listen("open-file-explorer", () => {
      addFileExplorerTab();
    });
    unlistenCodeEditor = await listen("open-code-editor", () => {
      const t = makeEditorTab();
      setTabs((prev) => [...prev, t]);
      setActiveTabId(t.id);
      scheduleSessionSave();
    });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
    window.removeEventListener("beforeunload", handleBeforeUnload);
    cancelScheduledSessionSave();
    unlistenFileExplorer?.();
    unlistenCodeEditor?.();
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Show when={config()}>
      <Switch>

        {/* ── Session landing ─────────────────────────────────────────── */}
        <Match when={!appReady()}>
          <div style={{
            position: "fixed", inset: "0",
            background: "#111",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "font-family": "Menlo, Monaco, 'Courier New', monospace",
            color: "#d4d4d4",
          }}>
            <div style={{
              width: "min(680px, calc(100vw - 48px))",
              background: "#171717",
              border: "1px solid #2d2d2d",
              "border-radius": "14px",
              padding: "26px",
              "box-shadow": "0 24px 60px rgba(0,0,0,0.45)",
              display: "flex",
              "flex-direction": "column",
              gap: "18px",
            }}>
              <div style={{ display: "flex", "justify-content": "space-between", gap: "18px", "align-items": "flex-start" }}>
                <div>
                  <div style={{ "font-size": "14px", color: "#888" }}>t-bias</div>
                  <div style={{ "font-size": "18px", color: "#ececec", "margin-top": "8px" }}>Session Landing</div>
                  <div style={{ "font-size": "12px", color: "#777", "margin-top": "6px", "line-height": "1.6" }}>
                    Leave the current workspace, start fresh, or load a saved session.
                  </div>
                </div>
                <Show when={pendingRestore()}>
                  <div style={{
                    "font-size": "11px",
                    color: "#666",
                    background: "#111",
                    border: "1px solid #252525",
                    "border-radius": "999px",
                    padding: "7px 10px",
                    "white-space": "nowrap",
                  }}>
                    {pendingRestore()!.tabs.length} tab{pendingRestore()!.tabs.length !== 1 ? "s" : ""} saved
                  </div>
                </Show>
              </div>

              <div style={{ display: "flex", gap: "10px", "flex-wrap": "wrap" }}>
                <Show when={pendingRestore()}>
                  <button
                    onClick={resumePendingSession}
                    style={{
                      background: "#5b8aff", border: "none", color: "#fff",
                      padding: "9px 16px", "border-radius": "8px",
                      "font-family": "inherit", "font-size": "12px", cursor: "pointer",
                    }}
                  >Resume Session</button>
                </Show>
                <button
                  onClick={startNewSession}
                  style={{
                    background: "#232323", border: "1px solid #444", color: "#d4d4d4",
                    padding: "9px 16px", "border-radius": "8px",
                    "font-family": "inherit", "font-size": "12px", cursor: "pointer",
                  }}
                >New Session</button>
              </div>

              <div style={{
                border: "1px solid #252525",
                "border-radius": "10px",
                overflow: "hidden",
                background: "#121212",
              }}>
                <div style={{
                  padding: "12px 14px",
                  "border-bottom": "1px solid #252525",
                  "font-size": "11px",
                  color: "#6f6f6f",
                  "text-transform": "uppercase",
                  "letter-spacing": "0.08em",
                }}>
                  Saved Sessions
                </div>
                <Show
                  when={namedSessions().length > 0}
                  fallback={
                    <div style={{ padding: "16px 14px", color: "#555", "font-size": "12px" }}>
                      No named sessions yet
                    </div>
                  }
                >
                  <div style={{ display: "flex", "flex-direction": "column" }}>
                    <For each={namedSessions()}>
                      {(name) => (
                        <button
                          onClick={() => void loadNamedSession(name)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#d4d4d4",
                            cursor: "pointer",
                            padding: "12px 14px",
                            "text-align": "left",
                            "font-family": "inherit",
                            "font-size": "12px",
                            "border-top": "1px solid #1d1d1d",
                          }}
                          title={`Load "${name}"`}
                        >
                          {name}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </Match>

        {/* ── Main app ───────────────────────────────────────────────── */}
        <Match when={appReady()}>
          <div style={{ display: "flex", "flex-direction": "column", width: "100%", height: "100%" }}>

            {/* ── Tab bar ─────────────────────────────────────────── */}
            <div style={{
              height: `${TAB_BAR_H}px`,
              "flex-shrink": "0",
              background: "#141414",
              display: "flex",
              "align-items": "stretch",
              overflow: "hidden",
              "border-bottom": "1px solid #2a2a2a",
              "user-select": "none",
              position: "relative",
            }}>
              {/* Flip — toggle active pane between terminal and explorer */}
              <button
                onClick={() => {
                  const t = tab();
                  if (t) toggleFlipPane(t.activePaneId);
                }}
                title="Flip pane (⌘/)"
                style={{
                  background: "none",
                  border: "none",
                  "border-right": "1px solid #222",
                  color: "#777",
                  cursor: "pointer",
                  padding: "0 12px",
                  "font-size": "11px",
                  "line-height": "1",
                  "flex-shrink": "0",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "font-family": "Menlo, Monaco, 'Courier New', monospace",
                }}
              >&lt;---</button>

              <For each={tabs}>
                {(t) => {
                  const isActive = () => t.id === activeTabId();
                  return (
                    <div
                      onClick={() => switchTab(t.id)}
                      title={t.title}
                      style={{
                        display: "flex", "align-items": "center", gap: "5px",
                        padding: "0 8px 0 12px", cursor: "default",
                        "font-family": "Menlo, Monaco, 'Courier New', monospace",
                        "font-size": "11px",
                        color: isActive() ? "#e0e0e0" : t.hasActivity ? "#7eadff" : "#666",
                        background: isActive() ? "#1e1e1e" : "transparent",
                        "border-right": "1px solid #222",
                        "box-shadow": isActive() ? "inset 0 -2px 0 #5b8aff" : "none",
                        "min-width": "72px", "max-width": "180px",
                        "flex-shrink": "0", position: "relative",
                      }}
                    >
                      <Show when={t.hasActivity && !isActive()}>
                        <span style={{ color: "#7eadff", "font-size": "8px", "flex-shrink": "0" }}>●</span>
                      </Show>
                      <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {t.title}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeTab(t.id); }}
                        title="Close tab"
                        style={{
                          background: "none", border: "none", color: "#555",
                          cursor: "pointer", padding: "1px 3px",
                          "font-size": "13px", "line-height": "1", "border-radius": "3px",
                          "flex-shrink": "0", opacity: tabs.length === 1 ? "0.2" : "1",
                        }}
                      >×</button>
                    </div>
                  );
                }}
              </For>

              {/* New terminal tab */}
              <button
                onClick={addTab}
                title="New tab (⌘T)"
                style={{
                  background: "none", border: "none", color: "#555",
                  cursor: "pointer", padding: "0 14px",
                  "font-size": "18px", "line-height": "1",
                  "flex-shrink": "0", "align-self": "center",
                }}
              >+</button>

              {/* Prompt Stacker button — far right */}
              <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", "flex-shrink": "0" }}>
                <button
                  onClick={() => void openSessionLanding()}
                  title="Open session landing"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#666",
                    cursor: "pointer",
                    padding: "0 12px",
                    "font-size": "11px",
                    height: "100%",
                    "border-left": "1px solid #222",
                    "font-family": "Menlo, Monaco, 'Courier New', monospace",
                  }}
                >Shells</button>
                <button
                  onClick={addPromptStackerTab}
                  title="Open Prompt Stacker"
                  style={{
                    background: "none",
                    border: "none", color: "#555",
                    cursor: "pointer", padding: "0 12px",
                    "font-size": "11px", height: "100%",
                    "border-left": "1px solid #222",
                    "font-family": "Menlo, Monaco, 'Courier New', monospace",
                  }}
                >Stacker</button>
              </div>

              {/* Sessions dropdown */}
              <Show when={sessionsMenuOpen()}>
                {/* Click-outside backdrop */}
                <div
                  style={{ position: "fixed", inset: "0", "z-index": "98" }}
                  onClick={() => { setSessionsMenuOpen(false); setSaveNameValue(null); }}
                />
                <div style={{
                  position: "absolute", top: `${TAB_BAR_H}px`, right: "0",
                  width: "220px",
                  background: "#1c1c1c",
                  border: "1px solid #333",
                  "border-top": "none",
                  "z-index": "99",
                  "font-family": "Menlo, Monaco, 'Courier New', monospace",
                  "font-size": "11px",
                  "box-shadow": "0 4px 16px rgba(0,0,0,0.5)",
                }}>
                  {/* Save current session */}
                  <Show when={saveNameValue() === null}>
                    <button
                      onClick={() => setSaveNameValue("")}
                      style={{
                        display: "block", width: "100%", background: "none",
                        border: "none", "border-bottom": "1px solid #2a2a2a",
                        color: "#aaa", cursor: "pointer",
                        padding: "8px 12px", "text-align": "left",
                        "font-family": "inherit", "font-size": "11px",
                      }}
                    >Save current session…</button>
                  </Show>

                  {/* Name input */}
                  <Show when={saveNameValue() !== null}>
                    <div style={{
                      padding: "8px",
                      "border-bottom": "1px solid #2a2a2a",
                      display: "flex", gap: "6px",
                    }}>
                      <input
                        autofocus
                        placeholder="Session name"
                        value={saveNameValue()!}
                        onInput={(e) => setSaveNameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveNamedSession(saveNameValue()!);
                          if (e.key === "Escape") { setSaveNameValue(null); }
                          e.stopPropagation();
                        }}
                        style={{
                          flex: "1", background: "#111", border: "1px solid #444",
                          color: "#d4d4d4", padding: "4px 6px",
                          "border-radius": "3px", "font-family": "inherit", "font-size": "11px",
                          outline: "none",
                        }}
                      />
                      <button
                        onClick={() => saveNamedSession(saveNameValue()!)}
                        style={{
                          background: "#5b8aff", border: "none", color: "#fff",
                          padding: "4px 8px", "border-radius": "3px",
                          cursor: "pointer", "font-size": "11px",
                        }}
                      >Save</button>
                    </div>
                  </Show>

                  {/* Saved sessions list */}
                  <Show
                    when={namedSessions().length > 0}
                    fallback={
                      <div style={{ padding: "8px 12px", color: "#444", "font-size": "11px" }}>
                        No saved sessions
                      </div>
                    }
                  >
                    <div style={{ "max-height": "200px", overflow: "auto" }}>
                      <For each={namedSessions()}>
                        {(name) => (
                          <div style={{
                            display: "flex", "align-items": "center",
                            "border-top": "1px solid #222",
                          }}>
                            <button
                              onClick={() => loadNamedSession(name)}
                              style={{
                                flex: "1", background: "none", border: "none",
                                color: "#bbb", cursor: "pointer",
                                padding: "7px 12px", "text-align": "left",
                                "font-family": "inherit", "font-size": "11px",
                                overflow: "hidden", "text-overflow": "ellipsis",
                                "white-space": "nowrap",
                              }}
                              title={`Load "${name}"`}
                            >{name}</button>
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteNamedSession(name); }}
                              title={`Delete "${name}"`}
                              style={{
                                background: "none", border: "none", color: "#444",
                                cursor: "pointer", padding: "4px 8px",
                                "font-size": "13px", "flex-shrink": "0",
                              }}
                            >×</button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>

            {/* ── Terminal panels ──────────────────────────────────── */}
            <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
              <For each={tabs}>
                {(t) => (
                  <div style={{
                    position: "absolute", inset: "0",
                    visibility: t.id === activeTabId() ? "visible" : "hidden",
                    "pointer-events": t.id === activeTabId() ? "auto" : "none",
                  }}>
                    <PanesRoot
                      rootId={t.rootId}
                      panes={t.panes}
                      activePaneId={t.activePaneId}
                      config={config()!}
                      zoomed={t.zoomed}
                      paneCwds={t.paneCwds}
                      onActivate={activatePane}
                      onTitleChange={(paneId, title) => handleTitleChange(t.id, paneId, title)}
                      onProcessTitleChange={(paneId, title) => handleProcessTitleChange(t.id, paneId, title)}
                      onCwdChange={(paneId, cwd) => handleCwdChange(t.id, paneId, cwd)}
                      onActivity={(paneId) => handleActivity(t.id, paneId)}
                      onRatioChange={handleRatioChange}
                      onFlip={toggleFlipPane}
                      onOpenFile={openFileInEditor}
                    />
                  </div>
                )}
              </For>
            </div>

            <Show when={promptStackerOpen()}>
              <div
                style={{
                  position: "fixed",
                  inset: "0",
                  background: "rgba(0,0,0,0.58)",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  padding: "24px",
                  "z-index": "120",
                }}
                onClick={() => closePromptStacker()}
              >
                <div
                  style={{
                    width: "min(860px, calc(100vw - 48px))",
                    height: "min(780px, calc(100vh - 48px))",
                    background: "#171717",
                    border: "1px solid #2d2d2d",
                    "border-radius": "14px",
                    padding: "26px",
                    "box-shadow": "0 24px 60px rgba(0,0,0,0.45)",
                    display: "flex",
                    "flex-direction": "column",
                    "min-height": "0",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <PromptStackerView
                    config={config()!}
                    isActive={promptStackerOpen()}
                    shouldFocus={promptStackerOpen()}
                    variant="modal"
                    onClose={closePromptStacker}
                  />
                </div>
              </div>
            </Show>

          </div>
        </Match>

      </Switch>
    </Show>
  );
};

export default App;
