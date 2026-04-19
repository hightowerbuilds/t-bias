import {
  createSignal,
  createEffect,
  createMemo,
  Show,
  For,
  onMount,
  type Component,
} from "solid-js";
import MarkdownIt from "markdown-it";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import {
  READ_DIR_CMD,
  GET_HOME_DIR_CMD,
  GET_PANE_CWD_CMD,
  READ_FILE_CMD,
  type DirEntry,
  type AppConfig,
} from "./ipc/types";
import "./styles/blog-preview.css";

const { invoke } = (window as any).__TAURI__.core;
const { shell } = (window as any).__TAURI__;

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

const SIDEBAR_WIDTH = "clamp(220px, 35%, 360px)";
const SIDEBAR_BUMPER_PX = 18;
const BLOG_FONT_FAMILY = "'Atkinson Hyperlegible', 'Iowan Old Style', Georgia, serif";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

function isMarkdownPath(path: string | null | undefined): boolean {
  return !!path && /\.(md|markdown)$/i.test(path);
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
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [previewMode, setPreviewMode] = createSignal<"source" | "blog">("source");

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

  createEffect(() => {
    if (!isMarkdownPath(selectedPath())) {
      setPreviewMode("source");
    }
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
        position: "relative",
        overflow: "hidden",
        background: "#1e1e1e",
        color: "#d4d4d4",
        "font-family": "Menlo, Monaco, 'Courier New', monospace",
      }}
    >
      {/* Left side: collapsible file tree */}
      <div
        style={{
          position: "absolute",
          top: "0",
          left: "0",
          bottom: "0",
          width: SIDEBAR_WIDTH,
          height: "100%",
          display: "flex",
          transform: sidebarOpen()
            ? "translateX(0)"
            : `translateX(calc(-100% + ${SIDEBAR_BUMPER_PX}px))`,
          transition: "transform 220ms ease",
          "z-index": "2",
        }}
      >
        <div
          style={{
            width: `calc(100% - ${SIDEBAR_BUMPER_PX}px)`,
            height: "100%",
            display: "flex",
            "flex-direction": "column",
            background: "#191919",
            "border-right": "1px solid #2e2e2e",
            "box-sizing": "border-box",
            "box-shadow": sidebarOpen() ? "10px 0 24px rgba(0,0,0,0.18)" : "none",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              padding: "8px 10px",
              "border-bottom": "1px solid #2e2e2e",
              background: "#171717",
              "user-select": "none",
              "flex-shrink": "0",
            }}
          >
            <span
              style={{
                flex: "1",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
                color: "#8c8c8c",
                "font-size": "11px",
                "letter-spacing": "0.04em",
                "text-transform": "uppercase",
              }}
            >
              {root()?.name || "Explorer"}
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              title="Hide sidebar"
              style={{
                background: "none",
                border: "1px solid #444",
                color: "#888",
                cursor: "pointer",
                padding: "2px 7px",
                "border-radius": "4px",
                "font-size": "11px",
                "line-height": "1",
              }}
            >
              ←
            </button>
          </div>

          <div
            style={{
              flex: "1",
              "overflow-y": "auto",
              "overflow-x": "hidden",
              "padding-top": "8px",
            }}
          >
            <Show when={root()}>
              <TreeNodeComponent node={root()!} depth={0} />
            </Show>
          </div>
        </div>

        <button
          onClick={() => setSidebarOpen((open) => !open)}
          title={sidebarOpen() ? "Hide sidebar" : "Show sidebar"}
          style={{
            width: `${SIDEBAR_BUMPER_PX}px`,
            height: "100%",
            background: sidebarOpen()
              ? "linear-gradient(180deg, #202020 0%, #191919 100%)"
              : "linear-gradient(180deg, #2a2a2a 0%, #202020 100%)",
            border: "none",
            "border-right": "1px solid #2e2e2e",
            color: sidebarOpen() ? "#666" : "#8fb1ff",
            cursor: "pointer",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "font-size": "11px",
            "font-weight": "bold",
            padding: "0",
            "box-sizing": "border-box",
          }}
        >
          {sidebarOpen() ? "◀" : "▶"}
        </button>
      </div>

      {/* Right side: file preview */}
      <div
        style={{
          position: "absolute",
          inset: "0",
          "padding-left": sidebarOpen() ? SIDEBAR_WIDTH : `${SIDEBAR_BUMPER_PX}px`,
          transition: "padding-left 220ms ease",
          "box-sizing": "border-box",
          height: "100%",
          display: "flex",
          "flex-direction": "column",
        }}
      >
        {/* Header with filename */}
        <div
          style={{
            padding: "8px 12px",
            "border-bottom": "1px solid #2e2e2e",
            "font-size": "12px",
            "user-select": "none",
            display: "flex",
            "align-items": "center",
            gap: "8px",
          }}
        >
          <button
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen() ? "Hide sidebar" : "Show sidebar"}
            style={{
              background: "none",
              border: "1px solid #444",
              color: sidebarOpen() ? "#888" : "#8fb1ff",
              cursor: "pointer",
              padding: "2px 8px",
              "border-radius": "4px",
              "font-size": "11px",
              "line-height": "1",
              "flex-shrink": "0",
            }}
          >
            {sidebarOpen() ? "Hide" : "Show"}
          </button>
          <Show when={selectedPath() && isMarkdownPath(selectedPath())}>
            <div
              style={{
                display: "flex",
                gap: "6px",
                "margin-right": "2px",
                "flex-shrink": "0",
              }}
            >
              <button
                onClick={() => setPreviewMode("source")}
                title="Show markdown source"
                style={{
                  background: previewMode() === "source" ? "#2d2d2d" : "none",
                  border: `1px solid ${previewMode() === "source" ? "#666" : "#444"}`,
                  color: previewMode() === "source" ? "#d4d4d4" : "#888",
                  cursor: "pointer",
                  padding: "2px 8px",
                  "border-radius": "999px",
                  "font-size": "11px",
                  "line-height": "1",
                }}
              >
                Source
              </button>
              <button
                onClick={() => setPreviewMode("blog")}
                title="Render markdown in blog mode"
                style={{
                  background: previewMode() === "blog" ? "#f0e5cf" : "none",
                  border: `1px solid ${previewMode() === "blog" ? "#d4b784" : "#444"}`,
                  color: previewMode() === "blog" ? "#4a3722" : "#888",
                  cursor: "pointer",
                  padding: "2px 10px",
                  "border-radius": "999px",
                  "font-size": "11px",
                  "line-height": "1",
                  "font-family": BLOG_FONT_FAMILY,
                }}
              >
                Blog MD
              </button>
            </div>
          </Show>
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
            <Show
              when={previewMode() === "blog" && isMarkdownPath(selectedPath())}
              fallback={<FlipEditorPreview content={fileContent()} config={props.config} />}
            >
              <FlipMarkdownPreview content={fileContent()} config={props.config} />
            </Show>
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

// ---------------------------------------------------------------------------
// FlipMarkdownPreview — blog-style markdown renderer
// ---------------------------------------------------------------------------

interface FlipMarkdownPreviewProps {
  content: string;
  config: AppConfig;
}

const FlipMarkdownPreview: Component<FlipMarkdownPreviewProps> = (props) => {
  const renderedHtml = createMemo(() => markdown.render(props.content));

  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const link = target?.closest("a");
    if (!link) return;

    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) return;

    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault();
      shell.open(href);
    }
  };

  return (
    <div
      class="flip-blog-preview"
      style={{ "--blog-bg": props.config.theme.background }}
      onClick={handleClick}
    >
      <article class="flip-blog-article" innerHTML={renderedHtml()} />
    </div>
  );
};
