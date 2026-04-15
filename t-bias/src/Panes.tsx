import {
  createSignal,
  Match,
  Show,
  Switch,
  onCleanup,
  type Component,
} from "solid-js";
import type { PaneMap, SplitPane } from "./pane-tree";
import TerminalView from "./Terminal";
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
  onActivate: (paneId: number) => void;
  onTitleChange: (paneId: number, title: string) => void;
  onActivity: (paneId: number) => void;
  onRatioChange: (splitId: number, ratio: number) => void;
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
          <TerminalView
            paneId={props.activePaneId}
            config={props.config}
            isActive={true}
            onTitleChange={(t) => props.onTitleChange(props.activePaneId, t)}
            onActivity={() => props.onActivity(props.activePaneId)}
          />
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
      {/* Terminal leaf */}
      <Match when={pane()?.type === "terminal"}>
        <div
          style={{ width: "100%", height: "100%", position: "relative" }}
          onClick={() => props.onActivate(props.paneId)}
        >
          {/* Blue focus ring on the active pane */}
          <Show when={props.paneId === props.activePaneId}>
            <div
              style={{
                position: "absolute",
                inset: "0",
                border: "1px solid #3d6dcc",
                "pointer-events": "none",
                "z-index": "20",
                "box-sizing": "border-box",
              }}
            />
          </Show>
          <TerminalView
            paneId={props.paneId}
            config={props.config}
            isActive={props.paneId === props.activePaneId}
            onTitleChange={(t) => props.onTitleChange(props.paneId, t)}
            onActivity={() => props.onActivity(props.paneId)}
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
