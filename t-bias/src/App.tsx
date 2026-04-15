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
import {
  splitPane,
  closePane,
  terminalIds,
  findAdjacent,
  type PaneMap,
} from "./pane-tree";
import { GET_CONFIG_CMD, type AppConfig } from "./ipc/types";

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
  /** Title of the active pane (updated via OSC 0/2). Fallback: "Shell". */
  title: string;
  hasActivity: boolean;
  rootId: number;
  activePaneId: number;
  panes: PaneMap;
  /** Per-pane title cache (so switching panes restores the right title). */
  paneTitles: Record<number, string>;
  /** When true, the active pane fills the entire tab area. */
  zoomed: boolean;
}

function makeInitialTab(): TabState {
  const tabId = newId();
  const paneId = newId();
  return {
    id: tabId,
    title: "Shell",
    hasActivity: false,
    rootId: paneId,
    activePaneId: paneId,
    panes: { [paneId]: { type: "terminal", id: paneId } },
    paneTitles: { [paneId]: "Shell" },
    zoomed: false,
  };
}

function makeNewTab(): TabState {
  const tabId = newId();
  const paneId = newId();
  return {
    id: tabId,
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
// App
// ---------------------------------------------------------------------------

const App: Component = () => {
  const [config, setConfig] = createSignal<AppConfig | null>(null);
  const [tabs, setTabs] = createStore<TabState[]>([makeInitialTab()]);
  const [activeTabId, setActiveTabId] = createSignal<number>(tabs[0].id);

  // Reactive helpers
  const tabIdx = () => tabs.findIndex((t) => t.id === activeTabId());
  const tab = () => tabs[tabIdx()];

  // ── Tab operations ──────────────────────────────────────────────────────

  const addTab = () => {
    const t = makeNewTab();
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
  };

  const switchTab = (id: number) => {
    setActiveTabId(id);
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx >= 0) setTabs(idx, "hasActivity", false);
  };

  /** Close the entire tab (removes it from the list). */
  const removeTab = (id: number) => {
    const current = tabs.slice();
    if (current.length === 1) return;
    const idx = current.findIndex((t) => t.id === id);
    if (id === activeTabId()) {
      const next = idx > 0 ? current[idx - 1] : current[idx + 1];
      setActiveTabId(next.id);
    }
    setTabs((prev) => prev.filter((t) => t.id !== id));
  };

  // ── Pane operations ─────────────────────────────────────────────────────

  const splitActivePane = (dir: "h" | "v") => {
    const t = tab();
    if (!t || t.zoomed) return;

    const splitId = newId();
    const newLeafId = newId();
    const { panes: newPanes, rootId: newRootId } = splitPane(
      t.panes,
      t.rootId,
      t.activePaneId,
      dir,
      splitId,
      newLeafId,
    );

    const idx = tabIdx();
    setTabs(idx, produce((draft) => {
      draft.panes = newPanes;
      draft.rootId = newRootId;
      draft.activePaneId = newLeafId;
      draft.paneTitles[newLeafId] = "Shell";
    }));
  };

  /** Close the active pane. If it's the last pane in the tab, close the tab. */
  const closeActivePane = () => {
    const t = tab();
    if (!t) return;

    const leaves = terminalIds(t.panes, t.rootId);
    if (leaves.length <= 1) {
      removeTab(t.id);
      return;
    }

    if (t.zoomed) {
      // Exit zoom first, then close
      setTabs(tabIdx(), "zoomed", false);
      return;
    }

    const { panes: newPanes, rootId: newRootId, focusId } = closePane(
      t.panes,
      t.rootId,
      t.activePaneId,
    );

    const idx = tabIdx();
    setTabs(idx, produce((draft) => {
      draft.panes = newPanes;
      draft.rootId = newRootId;
      draft.activePaneId = focusId;
      draft.title = draft.paneTitles[focusId] ?? "Shell";
      delete draft.paneTitles[t.activePaneId];
    }));
  };

  const activatePane = (paneId: number) => {
    const idx = tabIdx();
    setTabs(idx, produce((draft) => {
      draft.activePaneId = paneId;
      draft.title = draft.paneTitles[paneId] ?? "Shell";
      draft.hasActivity = false;
    }));
  };

  const navigatePane = (dir: "left" | "right" | "up" | "down") => {
    const t = tab();
    if (!t || t.zoomed) return;
    const adjacent = findAdjacent(t.panes, t.rootId, t.activePaneId, dir);
    if (adjacent !== null) activatePane(adjacent);
  };

  const toggleZoom = () => {
    const idx = tabIdx();
    setTabs(idx, "zoomed", (z) => !z);
  };

  const handleRatioChange = (splitId: number, ratio: number) => {
    const idx = tabIdx();
    setTabs(idx, "panes", splitId as any, "ratio" as any, ratio);
  };

  const handleTitleChange = (tabId: number, paneId: number, title: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    setTabs(idx, produce((draft) => {
      draft.paneTitles[paneId] = title;
      if (draft.activePaneId === paneId) draft.title = title;
    }));
  };

  const handleActivity = (tabId: number, paneId: number) => {
    const t = tabs.find((t) => t.id === tabId);
    if (!t || t.activePaneId === paneId) return;
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (tabId !== activeTabId()) {
      setTabs(idx, "hasActivity", true);
    }
  };

  // ── Global keyboard shortcuts ──────────────────────────────────────────
  // Capture phase: intercepts before TerminalHost handles the event.

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    const key = e.key.toLowerCase();

    // Cmd+T — new tab
    if (key === "t" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      addTab();
      return;
    }

    // Cmd+W — close active pane (or tab if it's the last pane)
    if (key === "w" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      closeActivePane();
      return;
    }

    // Cmd+D — split side-by-side (horizontal)
    if (key === "d" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      splitActivePane("h");
      return;
    }

    // Cmd+Shift+D — split stacked (vertical)
    if (key === "d" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      splitActivePane("v");
      return;
    }

    // Cmd+Shift+Enter — toggle zoom
    if (e.key === "Enter" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleZoom();
      return;
    }

    // Cmd+1-9 — switch tabs
    const digit = parseInt(e.key, 10);
    if (!isNaN(digit) && digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
      if (digit - 1 < tabs.length) {
        e.preventDefault();
        switchTab(tabs[digit - 1].id);
      }
      return;
    }

    // Cmd+Shift+[ — previous tab
    if (e.code === "BracketLeft" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeTabId());
      if (idx > 0) switchTab(tabs[idx - 1].id);
      return;
    }

    // Cmd+Shift+] — next tab
    if (e.code === "BracketRight" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeTabId());
      if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
      return;
    }

    // Cmd+Option+Arrow — navigate panes
    if (e.altKey && !e.shiftKey) {
      const dirs: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      const dir = dirs[e.key];
      if (dir) {
        e.preventDefault();
        navigatePane(dir);
        return;
      }
    }
  };

  onMount(async () => {
    const cfg = (await invoke(GET_CONFIG_CMD)) as AppConfig;
    setConfig(cfg);
    window.addEventListener("keydown", handleGlobalKeyDown, { capture: true });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Show when={config()}>
      <div style={{ display: "flex", "flex-direction": "column", width: "100%", height: "100%" }}>

        {/* ── Tab bar ──────────────────────────────────────────────────── */}
        <div style={{
          height: `${TAB_BAR_H}px`,
          "flex-shrink": "0",
          background: "#141414",
          display: "flex",
          "align-items": "stretch",
          overflow: "hidden",
          "border-bottom": "1px solid #2a2a2a",
          "user-select": "none",
        }}>
          <For each={tabs}>
            {(t) => {
              const isActive = () => t.id === activeTabId();
              return (
                <div
                  onClick={() => switchTab(t.id)}
                  title={t.title}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "5px",
                    padding: "0 8px 0 12px",
                    cursor: "default",
                    "font-family": "Menlo, Monaco, 'Courier New', monospace",
                    "font-size": "11px",
                    color: isActive() ? "#e0e0e0" : t.hasActivity ? "#7eadff" : "#666",
                    background: isActive() ? "#1e1e1e" : "transparent",
                    "border-right": "1px solid #222",
                    "box-shadow": isActive() ? "inset 0 -2px 0 #5b8aff" : "none",
                    "min-width": "72px",
                    "max-width": "180px",
                    "flex-shrink": "0",
                    position: "relative",
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
                      background: "none",
                      border: "none",
                      color: "#555",
                      cursor: "pointer",
                      padding: "1px 3px",
                      "font-size": "13px",
                      "line-height": "1",
                      "border-radius": "3px",
                      "flex-shrink": "0",
                      opacity: tabs.length === 1 ? "0.2" : "1",
                    }}
                  >×</button>
                </div>
              );
            }}
          </For>

          <button
            onClick={addTab}
            title="New tab (⌘T)"
            style={{
              background: "none",
              border: "none",
              color: "#555",
              cursor: "pointer",
              padding: "0 14px",
              "font-size": "18px",
              "line-height": "1",
              "flex-shrink": "0",
              "align-self": "center",
            }}
          >+</button>
        </div>

        {/* ── Terminal panels ──────────────────────────────────────────── */}
        {/* All tabs stay mounted (PTYs keep running); inactive ones are   */}
        {/* hidden with `visibility:hidden` so layout + fit() still work.  */}
        <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
          <For each={tabs}>
            {(t) => (
              <div style={{
                position: "absolute",
                inset: "0",
                visibility: t.id === activeTabId() ? "visible" : "hidden",
                "pointer-events": t.id === activeTabId() ? "auto" : "none",
              }}>
                <PanesRoot
                  rootId={t.rootId}
                  panes={t.panes}
                  activePaneId={t.activePaneId}
                  config={config()!}
                  zoomed={t.zoomed}
                  onActivate={(paneId) => activatePane(paneId)}
                  onTitleChange={(paneId, title) => handleTitleChange(t.id, paneId, title)}
                  onActivity={(paneId) => handleActivity(t.id, paneId)}
                  onRatioChange={(splitId, ratio) => handleRatioChange(splitId, ratio)}
                />
              </div>
            )}
          </For>
        </div>

      </div>
    </Show>
  );
};

export default App;
