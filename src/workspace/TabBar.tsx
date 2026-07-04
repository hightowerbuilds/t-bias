import { For } from "solid-js";
import type { Workspace } from "./store";

// Tab strip + pane action buttons. The action buttons make splits/zoom testable
// in a browser, where ⌘T/⌘W are swallowed by browser chrome during dev.
export default function TabBar(props: { ws: Workspace }) {
  const ws = props.ws;
  return (
    <div class="tabbar">
      <span class="brand">t-bias</span>
      <div class="tabs">
        <For each={ws.tabs}>
          {(tab) => (
            <div
              class="tab"
              classList={{ active: tab.id === ws.activeTabId() }}
              onMouseDown={() => ws.setActiveTabId(tab.id)}
            >
              <span class="tab-title">{tab.title}</span>
              <button
                class="tab-close"
                title="Close tab"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  ws.removeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button class="tab-new" title="New tab (⌘T)" onClick={() => ws.addTab()}>
          +
        </button>
      </div>

      <div class="pane-actions">
        <button title="Split right (⌘D)" onClick={() => ws.splitActive("h")}>⇋</button>
        <button title="Split down (⌘⇧D)" onClick={() => ws.splitActive("v")}>⤢</button>
        <button title="Zoom pane (⌘⏎)" onClick={() => ws.toggleZoom()}>⤡</button>
        <button title="Close pane (⌘W)" onClick={() => ws.closeActive()}>✕</button>
      </div>
    </div>
  );
}
