import { createResource, createSignal, For, Show } from "solid-js";
import { joinPath, listDirectory, type DirEntry } from "../lib/fs";
import type { ExplorerPane as ExplorerPaneNode } from "../pane-tree";

export default function ExplorerPane(props: { pane: ExplorerPaneNode }) {
  const [path, setPath] = createSignal(props.pane.cwd ?? ".");
  const [entries] = createResource(path, listDirectory, { initialValue: [] });

  const navigate = (name: string, type: DirEntry["type"]) => {
    if (type !== "directory") return;
    setPath((p) => joinPath(p, name));
  };

  const goUp = () => {
    setPath((p) => {
      if (p === "" || p === ".") return ".";
      const parent = p.split("/").slice(0, -1).join("/");
      return parent || ".";
    });
  };

  return (
    <div class="explorer-pane">
      <div class="explorer-header">
        <button onClick={goUp} disabled={path() === "."}>↑</button>
        <span class="explorer-path">{path()}</span>
      </div>
      <div class="explorer-list">
        <Show when={entries.loading}>
          <div class="explorer-empty">loading…</div>
        </Show>
        <Show when={entries.error}>
          <div class="explorer-empty err">{String(entries.error)}</div>
        </Show>
        <For each={entries()}>
          {(entry) => (
            <div
              class="explorer-row"
              classList={{ directory: entry.type === "directory" }}
              onClick={() => navigate(entry.name, entry.type)}
            >
              <span class="explorer-icon">
                {entry.type === "directory" ? "📁" : entry.type === "symlink" ? "🔗" : "📄"}
              </span>
              <span class="explorer-name">{entry.name}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
