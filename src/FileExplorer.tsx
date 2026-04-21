import {
  createSignal,
  For,
  Show,
  onMount,
  type Component,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  type DirEntry,
  READ_DIR_CMD,
  WRITE_FILE_CMD,
  MOVE_ENTRY_CMD,
  CREATE_DIR_CMD,
  DELETE_ENTRY_CMD,
  GET_HOME_DIR_CMD,
  RESOLVE_EXISTING_DIR_CMD,
  type ResolvedDirectory,
  type AppConfig,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeNode {
  entry: DirEntry;
  expanded: boolean;
  children: TreeNode[] | null; // null = not loaded
  depth: number;
}

export interface FileExplorerViewProps {
  paneId: number;
  config: AppConfig;
  isActive: boolean;
  initialPath?: string;
  onOpenFile?: (filePath: string) => void;
  onRootPathChange?: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return "\u{1F4C1}";
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "TS";
    case "js": case "jsx": return "JS";
    case "rs": return "RS";
    case "json": return "{}";
    case "md": return "MD";
    case "toml": case "yaml": case "yml": return "CF";
    case "css": case "scss": return "CS";
    case "html": return "HT";
    default: return "\u{1F4C4}";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FileExplorerView: Component<FileExplorerViewProps> = (props) => {
  const [rootPath, setRootPath] = createSignal("");
  const [nodes, setNodes] = createStore<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [dragOverPath, setDragOverPath] = createSignal<string | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [newItemMode, setNewItemMode] = createSignal<{ parentPath: string; type: "file" | "dir" } | null>(null);
  const [newItemName, setNewItemName] = createSignal("");
  const [restoreNotice, setRestoreNotice] = createSignal<string | null>(null);

  const updateRootPath = (path: string) => {
    setRootPath(path);
    props.onRootPathChange?.(path);
  };

  // Load a directory and return TreeNode[]
  const loadDir = async (path: string, depth: number): Promise<TreeNode[]> => {
    try {
      const entries = (await invoke(READ_DIR_CMD, { path })) as DirEntry[];
      return entries.map((e) => ({
        entry: e,
        expanded: false,
        children: null,
        depth,
      }));
    } catch {
      return [];
    }
  };

  // Initialize
  onMount(async () => {
    try {
      let startPath = (await invoke(GET_HOME_DIR_CMD)) as string;
      if (props.initialPath) {
        const resolution = (await invoke(RESOLVE_EXISTING_DIR_CMD, {
          path: props.initialPath,
        })) as ResolvedDirectory;
        startPath = resolution.resolved_path;
        if (!resolution.exact && resolution.resolved_path !== props.initialPath) {
          setRestoreNotice(`Restored to ${resolution.resolved_path} because ${props.initialPath} is no longer available.`);
        }
      }
      updateRootPath(startPath);
      const children = await loadDir(startPath, 0);
      setNodes(children);
    } catch {}
  });

  // Navigate to path
  const navigateTo = async (path: string) => {
    setRestoreNotice(null);
    updateRootPath(path);
    const children = await loadDir(path, 0);
    setNodes(children);
    setSelectedPath(null);
  };

  // Navigate up
  const navigateUp = () => {
    const current = rootPath();
    const parent = current.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  };

  // Toggle expand/collapse — uses produce at the root to mutate nested nodes
  const toggleExpand = async (indices: number[]) => {
    const getNode = (list: TreeNode[], idxPath: number[]): TreeNode | undefined => {
      let current = list;
      for (let i = 0; i < idxPath.length - 1; i++) {
        const n = current[idxPath[i]];
        if (!n?.children) return undefined;
        current = n.children;
      }
      return current[idxPath[idxPath.length - 1]];
    };

    const node = getNode(nodes, indices);
    if (!node || !node.entry.is_dir) return;

    if (node.children === null) {
      const children = await loadDir(node.entry.path, node.depth + 1);
      setNodes(produce((draft) => {
        const n = getNode(draft, indices);
        if (n) { n.children = children; n.expanded = true; }
      }));
    } else {
      setNodes(produce((draft) => {
        const n = getNode(draft, indices);
        if (n) n.expanded = !n.expanded;
      }));
    }
  };

  // Flatten the tree for rendering
  const flattenTree = (): { node: TreeNode; indices: number[] }[] => {
    const result: { node: TreeNode; indices: number[] }[] = [];
    const visit = (list: TreeNode[], parentIndices: number[]) => {
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const indices = [...parentIndices, i];
        result.push({ node: n, indices });
        if (n.expanded && n.children) {
          visit(n.children, indices);
        }
      }
    };
    visit(nodes, []);
    return result;
  };

  // Drag and drop handlers
  const handleDragStart = (e: DragEvent, path: string) => {
    e.dataTransfer?.setData("text/plain", path);
    e.dataTransfer!.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent, path: string, isDir: boolean) => {
    if (!isDir) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    setDragOverPath(path);
  };

  const handleDragLeave = () => {
    setDragOverPath(null);
  };

  const handleDrop = async (e: DragEvent, destDir: string) => {
    e.preventDefault();
    setDragOverPath(null);
    const src = e.dataTransfer?.getData("text/plain");
    if (!src || src === destDir) return;

    const fileName = src.split("/").pop()!;
    const dest = `${destDir}/${fileName}`;
    if (src === dest) return;

    try {
      await invoke(MOVE_ENTRY_CMD, { src, dest });
      // Refresh current view
      const children = await loadDir(rootPath(), 0);
      setNodes(children);
    } catch (err) {
      console.error("Move failed:", err);
    }
  };

  // Context menu actions
  const handleContextMenu = (e: MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
  };

  const dismissContextMenu = () => setContextMenu(null);

  const handleDelete = async (path: string) => {
    dismissContextMenu();
    try {
      await invoke(DELETE_ENTRY_CMD, { path });
      const children = await loadDir(rootPath(), 0);
      setNodes(children);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const handleNewFile = (parentPath: string) => {
    dismissContextMenu();
    setNewItemMode({ parentPath, type: "file" });
    setNewItemName("");
  };

  const handleNewFolder = (parentPath: string) => {
    dismissContextMenu();
    setNewItemMode({ parentPath, type: "dir" });
    setNewItemName("");
  };

  const submitNewItem = async () => {
    const mode = newItemMode();
    const name = newItemName().trim();
    if (!mode || !name) return;

    const fullPath = `${mode.parentPath}/${name}`;
    try {
      if (mode.type === "dir") {
        await invoke(CREATE_DIR_CMD, { path: fullPath });
      } else {
        // Create empty file via write_file
        await invoke(WRITE_FILE_CMD, { path: fullPath, contents: "" });
      }
      const children = await loadDir(rootPath(), 0);
      setNodes(children);
    } catch (err) {
      console.error("Create failed:", err);
    }
    setNewItemMode(null);
  };

  const handleRename = async (oldPath: string) => {
    const newName = renameValue().trim();
    if (!newName) { setRenaming(null); return; }

    const parentDir = oldPath.replace(/\/[^/]+$/, "");
    const dest = `${parentDir}/${newName}`;
    try {
      await invoke(MOVE_ENTRY_CMD, { src: oldPath, dest });
      const children = await loadDir(rootPath(), 0);
      setNodes(children);
    } catch (err) {
      console.error("Rename failed:", err);
    }
    setRenaming(null);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const flat = () => flattenTree();

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#1e1e1e",
        color: "#d4d4d4",
        "font-family": "var(--font-mono)",
        "font-size": "12px",
        display: "flex",
        "flex-direction": "column",
        "user-select": "none",
        overflow: "hidden",
      }}
      onClick={() => dismissContextMenu()}
    >
      {/* Header */}
      <div style={{
        padding: "6px 8px",
        background: "#181818",
        "border-bottom": "1px solid #2a2a2a",
        display: "flex",
        "align-items": "center",
        gap: "6px",
        "flex-shrink": "0",
      }}>
        <button
          onClick={navigateUp}
          title="Navigate up"
          style={{
            background: "none", border: "1px solid #444", color: "#888",
            cursor: "pointer", padding: "2px 8px", "border-radius": "3px",
            "font-size": "12px",
          }}
        >{"\u2191"}</button>
        <span style={{
          flex: "1",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          color: "#888",
          "font-size": "11px",
        }}>{rootPath()}</span>
        <button
          onClick={() => navigateTo(rootPath())}
          title="Refresh"
          style={{
            background: "none", border: "1px solid #444", color: "#888",
            cursor: "pointer", padding: "2px 8px", "border-radius": "3px",
            "font-size": "12px",
          }}
        >{"\u21BB"}</button>
      </div>

      <Show when={restoreNotice()}>
        <div
          style={{
            padding: "6px 8px",
            background: "#232018",
            color: "#d8c088",
            "border-bottom": "1px solid #3a3422",
            "font-size": "11px",
            "line-height": "1.5",
          }}
        >
          {restoreNotice()}
        </div>
      </Show>

      {/* New item input */}
      <Show when={newItemMode()}>
        <div style={{
          padding: "4px 8px",
          background: "#252525",
          "border-bottom": "1px solid #333",
          display: "flex",
          gap: "4px",
        }}>
          <input
            autofocus
            placeholder={newItemMode()!.type === "dir" ? "Folder name" : "File name"}
            value={newItemName()}
            onInput={(e) => setNewItemName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewItem();
              if (e.key === "Escape") setNewItemMode(null);
              e.stopPropagation();
            }}
            style={{
              flex: "1", background: "#111", border: "1px solid #444",
              color: "#d4d4d4", padding: "3px 6px", "border-radius": "3px",
              "font-family": "inherit", "font-size": "11px", outline: "none",
            }}
          />
          <button
            onClick={submitNewItem}
            style={{
              background: "#5b8aff", border: "none", color: "#fff",
              padding: "3px 8px", "border-radius": "3px",
              cursor: "pointer", "font-size": "11px",
            }}
          >Create</button>
        </div>
      </Show>

      {/* Tree */}
      <div style={{ flex: "1", overflow: "auto" }}>
        <For each={flat()}>
          {({ node, indices }) => {
            const isSelected = () => selectedPath() === node.entry.path;
            const isDragOver = () => dragOverPath() === node.entry.path;
            const isRenamingThis = () => renaming() === node.entry.path;

            return (
              <div
                draggable={true}
                onDragStart={(e) => handleDragStart(e, node.entry.path)}
                onDragOver={(e) => handleDragOver(e, node.entry.path, node.entry.is_dir)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, node.entry.path)}
                onClick={() => {
                  setSelectedPath(node.entry.path);
                  if (node.entry.is_dir) toggleExpand(indices);
                }}
                onDblClick={() => {
                  if (!node.entry.is_dir) {
                    props.onOpenFile?.(node.entry.path);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, node.entry.path, node.entry.is_dir)}
                style={{
                  display: "flex",
                  "align-items": "center",
                  padding: "2px 8px",
                  "padding-left": `${8 + node.depth * 16}px`,
                  cursor: "pointer",
                  background: isDragOver()
                    ? "#264f78"
                    : isSelected()
                      ? "#2a2d2e"
                      : "transparent",
                  "border-left": isDragOver() ? "2px solid #5b8aff" : "2px solid transparent",
                }}
              >
                {/* Expand arrow */}
                <span style={{
                  width: "14px",
                  "text-align": "center",
                  color: "#666",
                  "flex-shrink": "0",
                  "font-size": "10px",
                }}>
                  {node.entry.is_dir ? (node.expanded ? "\u25BC" : "\u25B6") : ""}
                </span>

                {/* Icon */}
                <span style={{
                  width: "22px",
                  "text-align": "center",
                  "flex-shrink": "0",
                  "font-size": node.entry.is_dir ? "12px" : "9px",
                  color: node.entry.is_dir ? "#dcb67a" : "#569cd6",
                  "font-weight": node.entry.is_dir ? "normal" : "bold",
                }}>
                  {fileIcon(node.entry.name, node.entry.is_dir)}
                </span>

                {/* Name */}
                <Show
                  when={!isRenamingThis()}
                  fallback={
                    <input
                      autofocus
                      value={renameValue()}
                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename(node.entry.path);
                        if (e.key === "Escape") setRenaming(null);
                        e.stopPropagation();
                      }}
                      onBlur={() => setRenaming(null)}
                      style={{
                        flex: "1", background: "#111", border: "1px solid #444",
                        color: "#d4d4d4", padding: "1px 4px", "border-radius": "2px",
                        "font-family": "inherit", "font-size": "12px", outline: "none",
                      }}
                    />
                  }
                >
                  <span style={{
                    flex: "1",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                    color: node.entry.is_dir ? "#dcb67a" : "#d4d4d4",
                  }}>
                    {node.entry.name}
                  </span>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      {/* Context menu */}
      <Show when={contextMenu()}>
        {(menu) => (
          <>
            <div
              style={{ position: "fixed", inset: "0", "z-index": "98" }}
              onClick={dismissContextMenu}
            />
            <div style={{
              position: "fixed",
              left: `${menu().x}px`,
              top: `${menu().y}px`,
              "z-index": "99",
              background: "#2d2d2d",
              border: "1px solid #555",
              "border-radius": "4px",
              "min-width": "140px",
              "box-shadow": "0 2px 8px rgba(0,0,0,0.5)",
              overflow: "hidden",
            }}>
              <Show when={menu().isDir}>
                <button
                  onClick={() => handleNewFile(menu().path)}
                  style={ctxItemStyle()}
                >New File</button>
                <button
                  onClick={() => handleNewFolder(menu().path)}
                  style={ctxItemStyle()}
                >New Folder</button>
                <div style={{ "border-top": "1px solid #444", margin: "2px 0" }} />
              </Show>
              <button
                onClick={() => {
                  setRenaming(menu().path);
                  setRenameValue(menu().path.split("/").pop()!);
                  dismissContextMenu();
                }}
                style={ctxItemStyle()}
              >Rename</button>
              <button
                onClick={() => handleDelete(menu().path)}
                style={{ ...ctxItemStyle(), color: "#f44747" }}
              >Delete</button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

function ctxItemStyle(): Record<string, string> {
  return {
    display: "block",
    width: "100%",
    background: "none",
    border: "none",
    color: "#d4d4d4",
    cursor: "pointer",
    padding: "6px 14px",
    "text-align": "left",
    "font-family": "var(--font-mono)",
    "font-size": "12px",
  };
}

export default FileExplorerView;
