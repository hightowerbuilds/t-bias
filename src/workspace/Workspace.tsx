import { createEffect, For, onCleanup, onMount } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { debounce } from "../lib/debounce";
import { loadWorkspace, saveWorkspace, type SavedWorkspace } from "../lib/api";
import { registerHotkeys } from "../lib/hotkeys";
import { createWorkspace } from "./store";
import Panes from "./Panes";
import TabBar from "./TabBar";

// The main app surface: a tab strip over stacked pane trees. Every tab stays
// mounted (visibility-toggled) so background terminals keep running.
export default function Workspace() {
  const ws = createWorkspace();
  const workspaceQuery = useQuery(() => ({
    queryKey: ["workspace"],
    queryFn: loadWorkspace,
  }));

  // Hydrate once from the persisted workspace, if any.
  let hydrated = false;
  createEffect(() => {
    if (!workspaceQuery.isSuccess || workspaceQuery.isFetching) return;
    const data = workspaceQuery.data;
    if (data && !hydrated) {
      hydrated = true;
      ws.hydrate(data);
    }
  });

  // Auto-save workspace layout changes (debounced).
  const AUTOSAVE_MS = 500;
  const sendSnapshot = (snapshot: SavedWorkspace) => {
    const blob = new Blob([JSON.stringify(snapshot)], { type: "application/json" });
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/workspace/save", blob);
      return;
    }
    saveWorkspace(snapshot).catch(() => {});
  };
  const debouncedSave = debounce(sendSnapshot, AUTOSAVE_MS);

  createEffect(() => {
    if (!workspaceQuery.isSuccess || workspaceQuery.isFetching) return;
    // Track reactive snapshot dependencies.
    const snapshot = ws.snapshot();
    // Save the initial default state too, but only after the query has settled.
    debouncedSave(snapshot);
  });

  onMount(() => {
    const unsub = registerHotkeys({
      "$mod+t": () => ws.addTab(),
      "$mod+w": () => ws.closeActive(),
      "$mod+d": () => ws.splitActive("h"),
      "$mod+Shift+D": () => ws.splitActive("v"),
      "$mod+Enter": () => ws.toggleZoom(),
      "$mod+[": () => ws.cycleTab(-1),
      "$mod+]": () => ws.cycleTab(1),
      "$mod+Alt+ArrowLeft": () => ws.navigate("left"),
      "$mod+Alt+ArrowRight": () => ws.navigate("right"),
      "$mod+Alt+ArrowUp": () => ws.navigate("up"),
      "$mod+Alt+ArrowDown": () => ws.navigate("down"),
      "$mod+=": () => ws.fontZoom(2),
      "$mod+-": () => ws.fontZoom(-2),
      "$mod+0": () => ws.fontZoomReset(),
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `$mod+${i + 1}`,
          () => ws.selectTabByIndex(i),
        ]),
      ),
    });

    const onBeforeUnload = () => sendSnapshot(ws.snapshot());
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        sendSnapshot(ws.snapshot());
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);

    onCleanup(() => {
      unsub();
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  });

  return (
    <div class="workspace">
      <TabBar ws={ws} />
      <div class="tab-area">
        <For each={ws.tabs}>
          {(tab) => (
            <div
              class="tab-view"
              classList={{ active: tab.id === ws.activeTabId() }}
            >
              <Panes ws={ws} tab={tab} />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
