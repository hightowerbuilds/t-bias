import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import ExplorerPane from "../explorer/ExplorerPane";
import type { ExplorerPane as ExplorerPaneNode, SplitPane, TerminalPane as TerminalPaneNode } from "../pane-tree";
import type { Tab, Workspace } from "./store";
import TerminalPane from "./TerminalPane";

const DIVIDER_PX = 5;

// Renders one tab's pane tree. When zoomed, only the active pane is rendered
// (its session survives in the cache, so background shells keep running).
export default function Panes(props: { ws: Workspace; tab: Tab }) {
  return (
    <Show
      when={props.tab.zoomed}
      fallback={<PaneNode ws={props.ws} tab={props.tab} paneId={props.tab.rootId} />}
    >
      <PaneNode ws={props.ws} tab={props.tab} paneId={props.tab.activePaneId} />
    </Show>
  );
}

function PaneNode(props: { ws: Workspace; tab: Tab; paneId: number }) {
  const pane = () => props.tab.panes[props.paneId];
  return (
    <Switch>
      <Match when={pane()?.type === "terminal"}>
        <TerminalPane
          ws={props.ws}
          paneId={props.paneId}
          tabId={props.tab.id}
          pane={pane() as TerminalPaneNode}
        />
      </Match>
      <Match when={pane()?.type === "explorer"}>
        <ExplorerPane pane={pane() as ExplorerPaneNode} />
      </Match>
      <Match when={pane()?.type === "split"}>
        <SplitView ws={props.ws} tab={props.tab} split={pane() as SplitPane} />
      </Match>
    </Switch>
  );
}

function SplitView(props: { ws: Workspace; tab: Tab; split: SplitPane }) {
  let container!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);
  const isH = () => props.split.dir === "h";
  const aPct = () => `${props.split.ratio * 100}%`;

  const onDividerDown = (e: MouseEvent) => {
    e.preventDefault();
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const span = isH() ? rect.width - DIVIDER_PX : rect.height - DIVIDER_PX;
      const offset = isH() ? ev.clientX - rect.left : ev.clientY - rect.top;
      props.ws.setRatio(props.split.id, Math.max(0.1, Math.min(0.9, offset / span)));
    };
    const onUp = () => {
      setDragging(false);
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
      ref={container}
      class="split"
      style={{ "flex-direction": isH() ? "row" : "column" }}
    >
      <div
        class="split-a"
        style={{ [isH() ? "width" : "height"]: aPct() }}
      >
        <PaneNode ws={props.ws} tab={props.tab} paneId={props.split.a} />
      </div>
      <div
        class="split-divider"
        classList={{ dragging: dragging(), vertical: !isH() }}
        onMouseDown={onDividerDown}
      />
      <div class="split-b">
        <PaneNode ws={props.ws} tab={props.tab} paneId={props.split.b} />
      </div>
    </div>
  );
}
