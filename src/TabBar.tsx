import { For, Show, type Component, type Accessor } from "solid-js";
import type { WorkspaceTabState } from "./workspace-state";

const TAB_BAR_H = 30;

export { TAB_BAR_H };

export const TabBar: Component<{
  tabs: WorkspaceTabState[];
  activeTabId: Accessor<number>;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onNewTab: () => void;
  onFlip: () => void;
  onOpenShells: () => void;
  onOpenStacker: () => void;
  onOpenCanvas: () => void;
  onOpenSettings: () => void;
}> = (props) => {
  return (
    <div style={{
      height: `${TAB_BAR_H}px`,
      "flex-shrink": "0",
      background: "var(--bg-tab-bar)",
      display: "flex",
      "align-items": "stretch",
      overflow: "hidden",
      "border-bottom": "1px solid var(--border)",
      "user-select": "none",
      position: "relative",
    }}>
      <button
        onClick={props.onFlip}
        title="Flip pane (⌘/)"
        style={{
          background: "none",
          border: "none",
          "border-right": "1px solid var(--border-separator)",
          color: "var(--text-sublabel)",
          cursor: "pointer",
          padding: "0 12px",
          "font-size": "11px",
          "line-height": "1",
          "flex-shrink": "0",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "font-family": "var(--font-mono)",
        }}
      >&lt;---</button>

      <For each={props.tabs}>
        {(currentTab) => {
          const isActive = () => currentTab.id === props.activeTabId();
          return (
            <div
              onClick={() => props.onSelectTab(currentTab.id)}
              title={currentTab.title}
              style={{
                display: "flex",
                "align-items": "center",
                gap: "5px",
                padding: "0 8px 0 12px",
                cursor: "default",
                "font-family": "var(--font-mono)",
                "font-size": "11px",
                color: isActive() ? "#e0e0e0" : currentTab.hasActivity ? "var(--accent-activity)" : "var(--text-dim)",
                background: isActive() ? "var(--bg-base)" : "transparent",
                "border-right": "1px solid var(--border-separator)",
                "box-shadow": isActive() ? "inset 0 -2px 0 var(--accent)" : "none",
                "min-width": "72px",
                "max-width": "180px",
                "flex-shrink": "0",
                position: "relative",
              }}
            >
              <Show when={currentTab.hasActivity && !isActive()}>
                <span style={{ color: "var(--accent-activity)", "font-size": "8px", "flex-shrink": "0" }}>●</span>
              </Show>
              <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                {currentTab.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void props.onCloseTab(currentTab.id);
                }}
                title="Close tab"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-faint)",
                  cursor: "pointer",
                  padding: "1px 3px",
                  "font-size": "13px",
                  "line-height": "1",
                  "border-radius": "var(--radius-sm)",
                  "flex-shrink": "0",
                  opacity: props.tabs.length === 1 ? "0.2" : "1",
                }}
              >×</button>
            </div>
          );
        }}
      </For>

      <button
        onClick={props.onNewTab}
        title="New tab (⌘T)"
        style={{
          background: "none",
          border: "none",
          color: "var(--text-faint)",
          cursor: "pointer",
          padding: "0 14px",
          "font-size": "18px",
          "line-height": "1",
          "flex-shrink": "0",
          "align-self": "center",
        }}
      >+</button>

      <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", "flex-shrink": "0" }}>
        <button
          onClick={props.onOpenShells}
          title="Open shell registry"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            padding: "0 12px",
            "font-size": "11px",
            height: "100%",
            "border-left": "1px solid var(--border-separator)",
            "font-family": "var(--font-mono)",
          }}
        >Shells</button>
        <button
          onClick={props.onOpenStacker}
          title="Open Prompt Stacker"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-faint)",
            cursor: "pointer",
            padding: "0 12px",
            "font-size": "11px",
            height: "100%",
            "border-left": "1px solid var(--border-separator)",
            "font-family": "var(--font-mono)",
          }}
        >Stacker</button>
        <button
          onClick={props.onOpenCanvas}
          title="Open Canvas"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-faint)",
            cursor: "pointer",
            padding: "0 12px",
            "font-size": "11px",
            height: "100%",
            "border-left": "1px solid var(--border-separator)",
            "font-family": "var(--font-mono)",
          }}
        >Canvas</button>
        <button
          onClick={props.onOpenSettings}
          title="Settings"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-faint)",
            cursor: "pointer",
            padding: "0 12px",
            "font-size": "11px",
            height: "100%",
            "border-left": "1px solid var(--border-separator)",
            "font-family": "var(--font-mono)",
          }}
        >Settings</button>
      </div>
    </div>
  );
};
