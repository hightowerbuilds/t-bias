import { onMount, onCleanup, createSignal, createEffect, type Component } from "solid-js";
import { EditorHost } from "./editor/EditorHost";
import type { EditorPane } from "./pane-tree";
import type { AppConfig } from "./ipc/types";

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
      await editor.loadFile(props.pane.filePath);
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
    </div>
  );
};

export default EditorView;
