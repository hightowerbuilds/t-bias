import {
  createSignal,
  Match,
  Show,
  Switch,
  onCleanup,
  type Component,
} from "solid-js";
import type { PaneMap, SplitPane, EditorPane, TerminalPane } from "./pane-tree";
import TerminalView from "./Terminal";
import EditorView from "./Editor";
import FileExplorerView from "./FileExplorer";
import FlipExplorerView from "./FlipExplorer";
import type { AppConfig } from "./ipc/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIVIDER_PX = 4;

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface PanesRootProps {
  rootId: number;
  panes: PaneMap;
  activePaneId: number;
  config: AppConfig;
  zoomed: boolean;
  paneCwds: Record<number, string>;
  onActivate: (paneId: number) => void;
  onTitleChange: (paneId: number, title: string) => void;
  onCwdChange: (paneId: number, cwd: string) => void;
  onActivity: (paneId: number) => void;
  onRatioChange: (splitId: number, ratio: number) => void;
  onFlip?: (paneId: number) => void;
  onOpenFile?: (filePath: string) => void;
}

// ---------------------------------------------------------------------------
// PanesRoot — entry point rendered per tab
// ---------------------------------------------------------------------------

export const PanesRoot: Component<PanesRootProps> = (props) => {
  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Zoomed: active pane fills the whole tab */}
      <Show when={props.zoomed}>
        <div style={{ position: "absolute", inset: "0" }}>
          <Switch>
            <Match when={props.panes[props.activePaneId]?.type === "terminal"}>
              <TerminalView
                paneId={props.activePaneId}
                config={props.config}
                isActive={true}
                onTitleChange={(t) => props.onTitleChange(props.activePaneId, t)}
                onCwdChange={(cwd) => props.onCwdChange(props.activePaneId, cwd)}
                onActivity={() => props.onActivity(props.activePaneId)}
              />
            </Match>
            <Match when={props.panes[props.activePaneId]?.type === "file-explorer"}>
              <FileExplorerView
                paneId={props.activePaneId}
                config={props.config}
                isActive={true}
                onOpenFile={props.onOpenFile}
              />
            </Match>
            <Match when={props.panes[props.activePaneId]?.type === "editor"}>
              <EditorView
                paneId={props.activePaneId}
                pane={props.panes[props.activePaneId] as EditorPane}
                config={props.config}
                isActive={true}
                onTitleChange={(t) => props.onTitleChange(props.activePaneId, t)}
              />
            </Match>
          </Switch>
        </div>
      </Show>

      {/* Normal: full pane tree — kept mounted even while zoomed so PTYs run */}
      <div style={{
        position: "absolute",
        inset: "0",
        visibility: props.zoomed ? "hidden" : "visible",
        "pointer-events": props.zoomed ? "none" : "auto",
      }}>
        <PaneNode {...props} paneId={props.rootId} />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// PaneNode — recursive: either a terminal leaf or a split container
// ---------------------------------------------------------------------------

interface PaneNodeProps extends PanesRootProps {
  paneId: number;
}

const PaneNode: Component<PaneNodeProps> = (props) => {
  const pane = () => props.panes[props.paneId];

  return (
    <Switch>
      {/* Terminal leaf with flip animation */}
      <Match when={pane()?.type === "terminal"}>
        <div
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            perspective: "1200px",
          }}
          onClick={() => props.onActivate(props.paneId)}
        >
          {/* Flip container */}
          <div
            style={{
              width: "100%",
              height: "100%",
              position: "relative",
              "transform-style": "preserve-3d",
              transition: "transform 400ms ease-in-out",
              transform: (pane() as TerminalPane)?.flipped ? "rotateY(180deg)" : "rotateY(0deg)",
            }}
          >
            {/* Front face — Terminal */}
            <div
              style={{
                position: "absolute",
                inset: "0",
                "backface-visibility": "hidden",
                "z-index": (pane() as TerminalPane)?.flipped ? "0" : "1",
              }}
            >
              <Show when={props.paneId === props.activePaneId}>
                <div style={{ position: "absolute", inset: "0", border: "1px solid #3d6dcc", "pointer-events": "none", "z-index": "20", "box-sizing": "border-box" }} />
              </Show>
              {/* Hamburger flip button */}
              <button
                onClick={(e) => { e.stopPropagation(); props.onFlip?.(props.paneId); }}
                title="Flip to explorer (⌘/)"
                style={{
                  position: "absolute",
                  top: "6px",
                  left: "6px",
                  "z-index": "25",
                  background: "rgba(30,30,30,0.7)",
                  border: "1px solid #444",
                  color: "#888",
                  width: "26px",
                  height: "26px",
                  "border-radius": "4px",
                  cursor: "pointer",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "font-size": "14px",
                  "line-height": "1",
                  padding: "0",
                  opacity: "0.35",
                  transition: "opacity 150ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.35"; }}
              >☰</button>
              <TerminalView
                paneId={props.paneId}
                config={props.config}
                isActive={props.paneId === props.activePaneId && !(pane() as TerminalPane)?.flipped}
                onTitleChange={(t) => props.onTitleChange(props.paneId, t)}
                onCwdChange={(cwd) => props.onCwdChange(props.paneId, cwd)}
                onActivity={() => props.onActivity(props.paneId)}
              />
            </div>

            {/* Back face — File Explorer */}
            <div
              style={{
                position: "absolute",
                inset: "0",
                "backface-visibility": "hidden",
                transform: "rotateY(180deg)",
                "z-index": (pane() as TerminalPane)?.flipped ? "1" : "0",
              }}
            >
              <Show when={props.paneId === props.activePaneId}>
                <div style={{ position: "absolute", inset: "0", border: "1px solid #3d6dcc", "pointer-events": "none", "z-index": "20", "box-sizing": "border-box" }} />
              </Show>
              {/* Hamburger flip button */}
              <button
                onClick={(e) => { e.stopPropagation(); props.onFlip?.(props.paneId); }}
                title="Flip to terminal (⌘/)"
                style={{
                  position: "absolute",
                  top: "6px",
                  left: "6px",
                  "z-index": "25",
                  background: "rgba(30,30,30,0.7)",
                  border: "1px solid #444",
                  color: "#888",
                  width: "26px",
                  height: "26px",
                  "border-radius": "4px",
                  cursor: "pointer",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "font-size": "14px",
                  "line-height": "1",
                  padding: "0",
                  opacity: "0.35",
                  transition: "opacity 150ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.35"; }}
              >☰</button>
              <FlipExplorerView
                paneId={props.paneId}
                config={props.config}
                isActive={props.paneId === props.activePaneId && (pane() as TerminalPane)?.flipped}
                cwd={props.paneCwds[props.paneId]}
              />
            </div>
          </div>
        </div>
      </Match>

      {/* File Explorer leaf */}
      <Match when={pane()?.type === "file-explorer"}>
        <div
          style={{ width: "100%", height: "100%", position: "relative" }}
          onClick={() => props.onActivate(props.paneId)}
        >
          <Show when={props.paneId === props.activePaneId}>
            <div style={{ position: "absolute", inset: "0", border: "1px solid #3d6dcc", "pointer-events": "none", "z-index": "20", "box-sizing": "border-box" }} />
          </Show>
          <FileExplorerView
            paneId={props.paneId}
            config={props.config}
            isActive={props.paneId === props.activePaneId}
            onOpenFile={props.onOpenFile}
          />
        </div>
      </Match>

      {/* Editor leaf */}
      <Match when={pane()?.type === "editor"}>
        <div
          style={{ width: "100%", height: "100%", position: "relative" }}
          onClick={() => props.onActivate(props.paneId)}
        >
          <Show when={props.paneId === props.activePaneId}>
            <div style={{ position: "absolute", inset: "0", border: "1px solid #3d6dcc", "pointer-events": "none", "z-index": "20", "box-sizing": "border-box" }} />
          </Show>
          <EditorView
            paneId={props.paneId}
            pane={pane() as EditorPane}
            config={props.config}
            isActive={props.paneId === props.activePaneId}
            onTitleChange={(t) => props.onTitleChange(props.paneId, t)}
          />
        </div>
      </Match>

      {/* Split container */}
      <Match when={pane()?.type === "split"}>
        <SplitView {...props} split={pane() as SplitPane} />
      </Match>
    </Switch>
  );
};

// ---------------------------------------------------------------------------
// SplitView — renders two PaneNodes with a draggable divider
// ---------------------------------------------------------------------------

interface SplitViewProps extends PaneNodeProps {
  split: SplitPane;
}

const SplitView: Component<SplitViewProps> = (props) => {
  let containerRef!: HTMLDivElement;
  const [active, setActive] = createSignal(false);

  const isH = () => props.split.dir === "h";
  const aPct = () => `${props.split.ratio * 100}%`;

  const onDividerMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setActive(true);

    const onMove = (ev: MouseEvent) => {
      const rect = containerRef.getBoundingClientRect();
      const span = isH()
        ? rect.width - DIVIDER_PX
        : rect.height - DIVIDER_PX;
      const offset = isH()
        ? ev.clientX - rect.left
        : ev.clientY - rect.top;
      const ratio = Math.max(0.1, Math.min(0.9, offset / span));
      props.onRatioChange(props.split.id, ratio);
    };

    const onUp = () => {
      setActive(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    onCleanup(() => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    });
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        "flex-direction": isH() ? "row" : "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Pane A */}
      <div style={{
        [isH() ? "width" : "height"]: aPct(),
        [isH() ? "height" : "width"]: "100%",
        "flex-shrink": "0",
        overflow: "hidden",
        position: "relative",
      }}>
        <PaneNode {...props} paneId={props.split.a} />
      </div>

      {/* Divider */}
      <div
        onMouseDown={onDividerMouseDown}
        style={{
          [isH() ? "width" : "height"]: `${DIVIDER_PX}px`,
          [isH() ? "height" : "width"]: "100%",
          background: active() ? "#5b8aff" : "#1e1e1e",
          cursor: isH() ? "col-resize" : "row-resize",
          "flex-shrink": "0",
          "z-index": "10",
          "border-left": isH() ? "1px solid #2e2e2e" : "none",
          "border-top": isH() ? "none" : "1px solid #2e2e2e",
          "border-right": isH() ? "1px solid #2e2e2e" : "none",
          "border-bottom": isH() ? "none" : "1px solid #2e2e2e",
        }}
      />

      {/* Pane B */}
      <div style={{
        flex: "1",
        overflow: "hidden",
        position: "relative",
        "min-width": "0",
        "min-height": "0",
      }}>
        <PaneNode {...props} paneId={props.split.b} />
      </div>
    </div>
  );
};
