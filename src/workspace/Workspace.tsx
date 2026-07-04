import { createEffect, For, onCleanup, onMount } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { loadWorkspace, saveWorkspace } from "../lib/api";
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

    const save = () => {
      try {
        saveWorkspace(ws.snapshot());
      } catch {
        // Don't block shutdown on a failed save.
      }
    };
    window.addEventListener("beforeunload", save);

    onCleanup(() => {
      unsub();
      window.removeEventListener("beforeunload", save);
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
