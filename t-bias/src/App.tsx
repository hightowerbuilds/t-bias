import { createSignal, For, Show, onMount, onCleanup, type Component } from "solid-js";
import TerminalView from "./Terminal";
import { GET_CONFIG_CMD, type AppConfig } from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

interface Tab {
  id: number;
  title: string;
  /** Received output while not focused — show activity indicator. */
  hasActivity: boolean;
}

let nextTabId = 1;

const TAB_BAR_H = 30; // px

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const App: Component = () => {
  const [config, setConfig] = createSignal<AppConfig | null>(null);
  const [tabs, setTabs] = createSignal<Tab[]>([
    { id: nextTabId++, title: "Shell", hasActivity: false },
  ]);
  const [activeTabId, setActiveTabId] = createSignal<number>(tabs()[0].id);

  // ---- Tab operations -------------------------------------------------------

  const addTab = () => {
    const id = nextTabId++;
    setTabs((t) => [...t, { id, title: "Shell", hasActivity: false }]);
    setActiveTabId(id);
  };

  const switchTab = (id: number) => {
    setActiveTabId(id);
    // Clear activity indicator when the user switches to that tab.
    setTabs((t) =>
      t.map((tab) => (tab.id === id ? { ...tab, hasActivity: false } : tab)),
    );
  };

  const closeTab = (id: number) => {
    const current = tabs();
    if (current.length === 1) return; // never close the last tab
    const idx = current.findIndex((t) => t.id === id);
    if (id === activeTabId()) {
      // Switch to the nearest remaining tab.
      const next = idx > 0 ? current[idx - 1] : current[idx + 1];
      setActiveTabId(next.id);
      setTabs((t) =>
        t.map((tab) =>
          tab.id === next.id ? { ...tab, hasActivity: false } : tab,
        ),
      );
    }
    setTabs((t) => t.filter((tab) => tab.id !== id));
    // TerminalView's onCleanup fires when the component is removed from the
    // For-list, which calls CLOSE_TAB_CMD and disposes the TerminalHost.
  };

  const handleTitleChange = (id: number, title: string) => {
    setTabs((t) =>
      t.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
    );
  };

  const handleActivity = (id: number) => {
    if (id !== activeTabId()) {
      setTabs((t) =>
        t.map((tab) => (tab.id === id ? { ...tab, hasActivity: true } : tab)),
      );
    }
  };

  // ---- Global keyboard shortcuts -------------------------------------------
  // Runs in capture phase so it intercepts before TerminalHost sees the event.

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (!e.metaKey) return;

    const key = e.key.toLowerCase();

    // Cmd+T — new tab
    if (key === "t" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      addTab();
      return;
    }

    // Cmd+W — close current tab
    if (key === "w" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      closeTab(activeTabId());
      return;
    }

    // Cmd+1-9 — switch to tab by index
    const digit = parseInt(e.key, 10);
    if (!isNaN(digit) && digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
      const t = tabs();
      if (digit - 1 < t.length) {
        e.preventDefault();
        switchTab(t[digit - 1].id);
      }
      return;
    }

    // Cmd+Shift+[ — previous tab  (Shift+[ → key is "{")
    if (e.code === "BracketLeft" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const t = tabs();
      const idx = t.findIndex((tab) => tab.id === activeTabId());
      if (idx > 0) switchTab(t[idx - 1].id);
      return;
    }

    // Cmd+Shift+] — next tab  (Shift+] → key is "}")
    if (e.code === "BracketRight" && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const t = tabs();
      const idx = t.findIndex((tab) => tab.id === activeTabId());
      if (idx < t.length - 1) switchTab(t[idx + 1].id);
      return;
    }
  };

  onMount(async () => {
    // Fetch config once; all tabs share the same configuration.
    const cfg = (await invoke(GET_CONFIG_CMD)) as AppConfig;
    setConfig(cfg);
    window.addEventListener("keydown", handleGlobalKeyDown, { capture: true });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown, { capture: true });
  });

  // ---- Render ---------------------------------------------------------------

  return (
    <Show when={config()}>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          width: "100%",
          height: "100%",
        }}
      >
        {/* ── Tab bar ─────────────────────────────────────────────────────── */}
        <div
          style={{
            height: `${TAB_BAR_H}px`,
            "flex-shrink": "0",
            background: "#141414",
            display: "flex",
            "align-items": "stretch",
            overflow: "hidden",
            "border-bottom": "1px solid #2a2a2a",
            "user-select": "none",
          }}
        >
          <For each={tabs()}>
            {(tab) => {
              const isActive = () => tab.id === activeTabId();
              return (
                <div
                  onClick={() => switchTab(tab.id)}
                  title={tab.title}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "5px",
                    padding: "0 8px 0 12px",
                    cursor: "default",
                    "font-family": "Menlo, Monaco, 'Courier New', monospace",
                    "font-size": "11px",
                    color: isActive()
                      ? "#e0e0e0"
                      : tab.hasActivity
                        ? "#7eadff"
                        : "#666",
                    background: isActive() ? "#1e1e1e" : "transparent",
                    "border-right": "1px solid #222",
                    "box-shadow": isActive() ? "inset 0 -2px 0 #5b8aff" : "none",
                    "min-width": "72px",
                    "max-width": "180px",
                    position: "relative",
                    "flex-shrink": "0",
                  }}
                >
                  {/* Activity dot */}
                  <Show when={tab.hasActivity && !isActive()}>
                    <span style={{ color: "#7eadff", "font-size": "8px", "flex-shrink": "0" }}>
                      ●
                    </span>
                  </Show>

                  {/* Tab title */}
                  <span
                    style={{
                      flex: "1",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {tab.title}
                  </span>

                  {/* Close button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
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
                      opacity: tabs().length === 1 ? "0.2" : "1",
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            }}
          </For>

          {/* New tab button */}
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
          >
            +
          </button>
        </div>

        {/* ── Terminal panels ─────────────────────────────────────────────── */}
        {/* All tabs stay mounted so their PTYs keep running; only the active  */}
        {/* one is visible. `visibility:hidden` keeps layout intact so fit()   */}
        {/* continues to work correctly on hidden terminals.                   */}
        <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
          <For each={tabs()}>
            {(tab) => (
              <div
                style={{
                  position: "absolute",
                  inset: "0",
                  visibility:
                    tab.id === activeTabId() ? "visible" : "hidden",
                  "pointer-events":
                    tab.id === activeTabId() ? "auto" : "none",
                }}
              >
                <TerminalView
                  tabId={tab.id}
                  config={config()!}
                  isActive={tab.id === activeTabId()}
                  onTitleChange={(title) => handleTitleChange(tab.id, title)}
                  onActivity={() => handleActivity(tab.id)}
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
