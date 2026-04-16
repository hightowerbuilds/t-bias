import {
  createSignal,
  createEffect,
  Show,
  For,
  onMount,
  type Component,
} from "solid-js";
import {
  READ_DIR_CMD,
  GET_HOME_DIR_CMD,
  GET_PANE_CWD_CMD,
  READ_FILE_CMD,
  type DirEntry,
  type AppConfig,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  expanded: boolean;
  children?: TreeNode[];
  size?: number;
  modified?: number | null;
}

interface FlipExplorerViewProps {
  paneId: number;
  config: AppConfig;
  isActive: boolean;
  /** Current working directory of the linked terminal (from OSC 7). */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// FlipExplorerView — read-only file tree + preview
// ---------------------------------------------------------------------------

const FlipExplorerView: Component<FlipExplorerViewProps> = (props) => {
  let containerRef!: HTMLDivElement;
  const [root, setRoot] = createSignal<TreeNode | null>(null);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal<string>("");
  const [expandedPaths, setExpandedPaths] = createSignal<Set<string>>(new Set());

  // Load initial directory on mount (prefer cwd, fall back to home)
  onMount(async () => {
    const dir = props.cwd;
    if (dir) {
      const rootNode = await loadDir(dir);
      setRoot(rootNode);
    } else {
      try {
        const homeDir = await invoke<string>(GET_HOME_DIR_CMD);
        const rootNode = await loadDir(homeDir);
        setRoot(rootNode);
      } catch (err) {
        console.error("Failed to load home directory:", err);
      }
    }
  });

  // React to terminal cwd changes (OSC 7 path)
  createEffect(() => {
    const dir = props.cwd;
    if (!dir) return;
    const current = root();
    if (current && current.path === dir) return;
    loadDir(dir).then(setRoot);
  });

  // Pull-based: query the shell's CWD when we become active (on flip)
  createEffect(() => {
    if (!props.isActive) return;
    invoke<string | null>(GET_PANE_CWD_CMD, { paneId: props.paneId })
      .then((cwd) => {
        if (!cwd) return;
        const current = root();
        if (current && current.path === cwd) return;
        loadDir(cwd).then(setRoot);
      })
      .catch(() => {});
  });

  // Load directory contents
  const loadDir = async (dirPath: string): Promise<TreeNode> => {
    try {
      const entries = await invoke<DirEntry[]>(READ_DIR_CMD, { path: dirPath });
      const children = entries.map((e) => ({
        path: e.path,
        name: e.name,
        isDir: e.is_dir,
        expanded: false,
        size: e.size,
        modified: e.modified,
      }));
      return {
        path: dirPath,
        name: dirPath.split("/").pop() || "/",
        isDir: true,
        expanded: true,
        children,
      };
    } catch {
      return {
        path: dirPath,
        name: dirPath.split("/").pop() || "/",
        isDir: true,
        expanded: false,
      };
    }
  };

  // Toggle directory expansion
  const toggleExpand = async (path: string) => {
    const prev = expandedPaths();
    const next = new Set(prev);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setExpandedPaths(next);

    // Lazy load children if not already loaded
    if (next.has(path)) {
      const node = findNode(root()!, path);
      if (node && node.isDir && !node.children) {
        try {
          const entries = await invoke<DirEntry[]>(READ_DIR_CMD, { path });
          node.children = entries.map((e) => ({
            path: e.path,
            name: e.name,
            isDir: e.is_dir,
            expanded: false,
            size: e.size,
            modified: e.modified,
          }));
        } catch {
          node.children = [];
        }
      }
    }
  };

  // Find node by path (recursive)
  const findNode = (node: TreeNode, path: string): TreeNode | null => {
    if (node.path === path) return node;
    if (!node.children) return null;
    for (const child of node.children) {
      const found = findNode(child, path);
      if (found) return found;
    }
    return null;
  };

  // Select and load file
  const selectFile = async (path: string) => {
    setSelectedPath(path);
    try {
      const content = await invoke<string>(READ_FILE_CMD, { path });
      setFileContent(content);
    } catch (err) {
      console.error("Failed to read file:", err);
      setFileContent("");
    }
  };

  // Render file tree recursively
  const TreeNodeComponent: Component<{
    node: TreeNode;
    depth: number;
  }> = (nodeProps) => {
    const isExpanded = () => expandedPaths().has(nodeProps.node.path);
    const isSelected = () => selectedPath() === nodeProps.node.path;

    return (
      <div>
        <div
          style={{
            "padding-left": `${8 + nodeProps.depth * 16}px`,
            padding: `4px ${8 + nodeProps.depth * 16}px`,
            "user-select": "none",
            "cursor": "pointer",
            background: isSelected() ? "#264f78" : "transparent",
            color: isSelected() ? "#d4d4d4" : "#888",
            "font-size": "12px",
            "font-family": "Menlo, Monaco, 'Courier New', monospace",
            "white-space": "nowrap",
            "overflow": "hidden",
            "text-overflow": "ellipsis",
          }}
          onClick={async (e) => {
            e.stopPropagation();
            if (nodeProps.node.isDir) {
              await toggleExpand(nodeProps.node.path);
            } else {
              await selectFile(nodeProps.node.path);
            }
          }}
        >
          <span style={{ "margin-right": "4px" }}>
            {nodeProps.node.isDir ? (isExpanded() ? "▼" : "▶") : "•"}
          </span>
          {nodeProps.node.name}
        </div>

        {/* Render children if expanded */}
        <Show when={nodeProps.node.isDir && isExpanded() && nodeProps.node.children}>
          <For each={nodeProps.node.children}>
            {(child) => (
              <TreeNodeComponent node={child} depth={nodeProps.depth + 1} />
            )}
          </For>
        </Show>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#1e1e1e",
        color: "#d4d4d4",
        "font-family": "Menlo, Monaco, 'Courier New', monospace",
      }}
    >
      {/* Left side: file tree (35%) */}
      <div
        style={{
          width: "35%",
          height: "100%",
          "overflow-y": "auto",
          "overflow-x": "hidden",
          "border-right": "1px solid #2e2e2e",
          "box-sizing": "border-box",
          "padding-top": "8px",
        }}
      >
        <Show when={root()}>
          <TreeNodeComponent node={root()!} depth={0} />
        </Show>
      </div>

      {/* Right side: file preview (65%) */}
      <div
        style={{
          width: "65%",
          height: "100%",
          display: "flex",
          "flex-direction": "column",
          "box-sizing": "border-box",
        }}
      >
        {/* Header with filename */}
        <div
          style={{
            padding: "8px 12px",
            "border-bottom": "1px solid #2e2e2e",
            "font-size": "12px",
            "user-select": "none",
          }}
        >
          <span style={{ color: "#888" }}>
            {selectedPath()
              ? selectedPath()!.split("/").pop()
              : "Select a file"}
          </span>
        </div>

        {/* Preview content — read-only editor */}
        <div
          style={{
            flex: "1",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <Show when={selectedPath()}>
            <FlipEditorPreview content={fileContent()} config={props.config} />
          </Show>
          <Show when={!selectedPath()}>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                height: "100%",
                color: "#666",
                "font-size": "12px",
              }}
            >
              No file selected
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default FlipExplorerView;

// ---------------------------------------------------------------------------
// FlipEditorPreview — read-only text preview for file preview
// ---------------------------------------------------------------------------

interface FlipEditorPreviewProps {
  content: string;
  config: AppConfig;
}

const FlipEditorPreview: Component<FlipEditorPreviewProps> = (props) => {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "auto",
        background: "#1a1a1a",
        padding: "8px",
        "box-sizing": "border-box",
      }}
    >
      <pre
        style={{
          margin: "0",
          padding: "0",
          "font-family": "Menlo, Monaco, 'Courier New', monospace",
          "font-size": "12px",
          color: "#d4d4d4",
          "line-height": "1.5",
          "white-space": "pre-wrap",
          "word-break": "break-word",
          "user-select": "text",
          cursor: "text",
        }}
      >
        {props.content}
      </pre>
    </div>
  );
};
