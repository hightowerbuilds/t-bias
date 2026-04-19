import { onMount, onCleanup, createSignal, createEffect, type Component } from "solid-js";
import { EditorHost } from "./editor/EditorHost";
import type { EditorPane } from "./pane-tree";
import {
  RESOLVE_EXISTING_DIR_CMD,
  type AppConfig,
  type ResolvedDirectory,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;

export interface EditorViewProps {
  paneId: number;
  pane: EditorPane;
  config: AppConfig;
  isActive: boolean;
  onTitleChange?: (title: string) => void;
}

const EditorView: Component<EditorViewProps> = (props) => {
  let canvasRef!: HTMLCanvasElement;
  let editor: EditorHost | undefined;
  const [editorReady, setEditorReady] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  const dirname = (path: string): string => {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return "/";
    return path.slice(0, idx);
  };

  onMount(async () => {
    const config = props.config;

    editor = new EditorHost(canvasRef, {
      fontSize: config.font.size,
      fontFamily: config.font.family,
      theme: {
        background: config.theme.background,
        foreground: config.theme.foreground,
        cursor: config.theme.cursor,
        selectionBg: config.theme.selection_bg,
        ansi: config.theme.ansi,
      },
      filePath: props.pane.filePath,
    });

    setEditorReady(true);

    editor.onTitleChange = (title) => {
      props.onTitleChange?.(title);
    };

    if (props.pane.filePath) {
      try {
        await editor.loadFile(props.pane.filePath);
        setLoadError(null);
      } catch {
        let detail = `Could not reopen ${props.pane.filePath}. The file may have been moved or deleted.`;
        try {
          const resolution = (await invoke(RESOLVE_EXISTING_DIR_CMD, {
            path: dirname(props.pane.filePath),
          })) as ResolvedDirectory;
          if (resolution.resolved_path) {
            detail += ` Nearest existing folder: ${resolution.resolved_path}.`;
          }
        } catch {
          // Ignore fallback lookup failure; keep the primary message.
        }
        setLoadError(detail);
      }
    }

    const ro = new ResizeObserver(() => editor?.fit());
    const container = canvasRef.parentElement;
    if (container) ro.observe(container);

    onCleanup(() => {
      ro.disconnect();
      editor?.dispose();
    });
  });

  createEffect(() => {
    if (props.isActive && editorReady()) {
      editor!.focus();
    }
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          position: "absolute",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          display: "block",
          outline: "none",
        }}
      />
      {loadError() && (
        <div
          style={{
            position: "absolute",
            inset: "0",
            background: "rgba(12,12,12,0.78)",
            color: "var(--text-primary)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            padding: "24px",
            "box-sizing": "border-box",
            "font-family": "var(--font-mono)",
            "font-size": "12px",
            "line-height": "1.7",
            "text-align": "center",
          }}
        >
          <div style={{ width: "min(540px, 100%)" }}>
            {loadError()}
          </div>
        </div>
      )}
    </div>
  );
};

export default EditorView;
