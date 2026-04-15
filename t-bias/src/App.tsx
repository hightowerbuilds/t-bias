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
import {
  splitPane,
  closePane,
  terminalIds,
  findAdjacent,
  type PaneMap,
} from "./pane-tree";
import type { SplitPane } from "./pane-tree";
import {
  GET_CONFIG_CMD,
  SAVE_SESSION_CMD,
  LOAD_SESSION_CMD,
  SAVE_NAMED_SESSION_CMD,
  LOAD_NAMED_SESSION_CMD,
  LIST_NAMED_SESSIONS_CMD,
  DELETE_NAMED_SESSION_CMD,
  type AppConfig,
  type SessionData,
  type SavedPane,
  type SavedTab,
} from "./ipc/types";

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
  rootId: number;
  activePaneId: number;
  panes: PaneMap;
  paneTitles: Record<number, string>;
  zoomed: boolean;
}

function makeTab(): TabState {
  const paneId = newId();
  return {
    id: newId(),
    title: "Shell",
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "terminal", id: paneId } },
    paneTitles: { [paneId]: "Shell" },
    zoomed: false,
  };
}

const TAB_BAR_H = 30;

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function tabToSavedTab(t: TabState): SavedTab {
  function serPane(id: number): SavedPane {
    const p = t.panes[id];
    if (p.type === "terminal") return { type: "terminal" };
    const s = p as SplitPane;
    return { type: "split", dir: s.dir, ratio: s.ratio, a: serPane(s.a), b: serPane(s.b) };
  }
  const leaves = terminalIds(t.panes, t.rootId);
  return {
    layout: serPane(t.rootId),
    activePaneIndex: Math.max(0, leaves.indexOf(t.activePaneId)),
    title: t.title,
  };
}

function savedTabToTabState(saved: SavedTab): TabState {
  const terminalPaneIds: number[] = [];

  function buildPane(node: SavedPane): { id: number; panes: PaneMap } {
    if (node.type === "terminal") {
      const id = newId();
      terminalPaneIds.push(id);
      return { id, panes: { [id]: { type: "terminal", id } } };
    }
    const splitId = newId();
    const { id: aId, panes: aPanes } = buildPane(node.a);
    const { id: bId, panes: bPanes } = buildPane(node.b);
    return {
      id: splitId,
      panes: {
        ...aPanes,
        ...bPanes,
        [splitId]: { type: "split", id: splitId, dir: node.dir, ratio: node.ratio, a: aId, b: bId },
      },
    };
  }

  const { id: rootId, panes } = buildPane(saved.layout);
  const activePaneId =
    terminalPaneIds[Math.min(saved.activePaneIndex, terminalPaneIds.length - 1)] ??
    terminalPaneIds[0];
  const paneTitles: Record<number, string> = {};
  terminalPaneIds.forEach((id) => { paneTitles[id] = "Shell"; });

  return {
    id: newId(),
    title: saved.title ?? "Shell",
    hasActivity: false,
    rootId,
    activePaneId,
    panes,
    paneTitles,
    zoomed: false,
  };
}

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

  // Tab store
  const [tabs, setTabs] = createStore<TabState[]>([makeTab()]);
  const [activeTabId, setActiveTabId] = createSignal<number>(tabs[0].id);

  const tabIdx = () => tabs.findIndex((t) => t.id === activeTabId());
  const tab = () => tabs[tabIdx()];

  // ── Session: build + restore ─────────────────────────────────────────────

  const buildSessionData = (): SessionData => ({
    version: 1,
    activeTabIndex: Math.max(0, tabIdx()),
    tabs: tabs.map(tabToSavedTab),
  });

  const applySession = (data: SessionData) => {
    if (!data.tabs?.length) return;
    const restored = data.tabs.map(savedTabToTabState);
    setTabs(restored);
    const idx = Math.min(data.activeTabIndex ?? 0, restored.length - 1);
    setActiveTabId(restored[idx].id);
  };

  const saveSession = () => {
    invoke(SAVE_SESSION_CMD, { data: buildSessionData() }).catch(() => {});
  };

  const refreshNamedSessions = async () => {
    const names = (await invoke(LIST_NAMED_SESSIONS_CMD)) as string[];
    setNamedSessions(names);
  };

  // ── Tab operations ────────────────────────────────────────────────────────

  const addTab = () => {
    const t = makeTab();
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    saveSession();
  };

  const switchTab = (id: number) => {
    setActiveTabId(id);
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx >= 0) setTabs(idx, "hasActivity", false);
    saveSession();
  };

  const removeTab = (id: number) => {
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (id === activeTabId()) {
      const next = idx > 0 ? tabs[idx - 1] : tabs[idx + 1];
      setActiveTabId(next.id);
    }
    setTabs((prev) => prev.filter((t) => t.id !== id));
    saveSession();
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
    }));
    saveSession();
  };

  const closeActivePane = () => {
    const t = tab();
    if (!t) return;
    if (terminalIds(t.panes, t.rootId).length <= 1) {
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
      d.title = d.paneTitles[focusId] ?? "Shell";
      delete d.paneTitles[t.activePaneId];
    }));
    saveSession();
  };

  const activatePane = (paneId: number) => {
    setTabs(tabIdx(), produce((d) => {
      d.activePaneId = paneId;
      d.title = d.paneTitles[paneId] ?? "Shell";
      d.hasActivity = false;
    }));
  };

  const navigatePane = (dir: "left" | "right" | "up" | "down") => {
    const t = tab();
    if (!t || t.zoomed) return;
    const adj = findAdjacent(t.panes, t.rootId, t.activePaneId, dir);
    if (adj !== null) activatePane(adj);
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
      if (d.activePaneId === paneId) d.title = title;
    }));
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
    await invoke(SAVE_NAMED_SESSION_CMD, { name: name.trim(), data: buildSessionData() });
    setSaveNameValue(null);
    await refreshNamedSessions();
  };

  const loadNamedSession = async (name: string) => {
    const data = (await invoke(LOAD_NAMED_SESSION_CMD, { name })) as SessionData | null;
    if (data?.tabs?.length) applySession(data);
    setSessionsMenuOpen(false);
  };

  const deleteNamedSession = async (name: string) => {
    await invoke(DELETE_NAMED_SESSION_CMD, { name });
    await refreshNamedSessions();
  };

  // ── Global keyboard shortcuts ─────────────────────────────────────────────

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    const key = e.key.toLowerCase();

    if (key === "t" && !e.shiftKey && !e.altKey) { e.preventDefault(); addTab(); return; }
    if (key === "w" && !e.shiftKey && !e.altKey) { e.preventDefault(); closeActivePane(); return; }
    if (key === "d" && !e.shiftKey && !e.altKey) { e.preventDefault(); splitActivePane("h"); return; }
    if (key === "d" && e.shiftKey && !e.altKey)  { e.preventDefault(); splitActivePane("v"); return; }

    if (e.key === "Enter" && e.shiftKey && !e.altKey) { e.preventDefault(); toggleZoom(); return; }

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
      } else {
        // "never"
        setConfig(cfg);
        setAppReady(true);
      }
    } else {
      setConfig(cfg);
      setAppReady(true);
    }

    window.addEventListener("keydown", handleGlobalKeyDown, { capture: true });

    // Best-effort save when the page is unloaded.
    window.addEventListener("beforeunload", saveSession);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
    window.removeEventListener("beforeunload", saveSession);
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Show when={config()}>
      <Switch>

        {/* ── Restore prompt (ask mode) ───────────────────────────────── */}
        <Match when={!appReady() && pendingRestore()}>
          <div style={{
            position: "fixed", inset: "0",
            background: "#111",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "flex-direction": "column",
            gap: "20px",
            "font-family": "Menlo, Monaco, 'Courier New', monospace",
            color: "#d4d4d4",
          }}>
            <div style={{ "font-size": "14px", color: "#888" }}>t-bias</div>
            <div style={{ "font-size": "13px" }}>
              Restore previous session?
              <span style={{ color: "#555", "margin-left": "6px" }}>
                ({pendingRestore()!.tabs.length} tab{pendingRestore()!.tabs.length !== 1 ? "s" : ""})
              </span>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => {
                  applySession(pendingRestore()!);
                  setPendingRestore(null);
                  setAppReady(true);
                }}
                style={{
                  background: "#5b8aff", border: "none", color: "#fff",
                  padding: "6px 16px", "border-radius": "4px",
                  "font-family": "inherit", "font-size": "12px", cursor: "pointer",
                }}
              >Restore</button>
              <button
                onClick={() => { setPendingRestore(null); setAppReady(true); }}
                style={{
                  background: "#2a2a2a", border: "1px solid #444", color: "#aaa",
                  padding: "6px 16px", "border-radius": "4px",
                  "font-family": "inherit", "font-size": "12px", cursor: "pointer",
                }}
              >New session</button>
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

              {/* New tab */}
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

              {/* Sessions menu button — far right */}
              <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", "flex-shrink": "0" }}>
                <button
                  onClick={openSessionsMenu}
                  title="Sessions (⌘⇧S to save)"
                  style={{
                    background: sessionsMenuOpen() ? "#252525" : "none",
                    border: "none", color: "#555",
                    cursor: "pointer", padding: "0 12px",
                    "font-size": "14px", height: "100%",
                    "border-left": "1px solid #222",
                  }}
                >≡</button>
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
                      onActivate={activatePane}
                      onTitleChange={(paneId, title) => handleTitleChange(t.id, paneId, title)}
                      onActivity={(paneId) => handleActivity(t.id, paneId)}
                      onRatioChange={handleRatioChange}
                    />
                  </div>
                )}
              </For>
            </div>

          </div>
        </Match>

      </Switch>
    </Show>
  );
};

export default App;
