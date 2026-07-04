import { createEffect, onCleanup, onMount } from "solid-js";
import { mountTerminal, unmountTerminal, focusTerminal } from "../terminal/session";
import type { TerminalPane as TerminalPaneNode } from "../pane-tree";
import type { Workspace } from "./store";

// A single terminal leaf. Mounts (or reattaches) its cached session; the
// session — xterm host + WebSocket — outlives the component so splits/zoom
// don't reconnect the shell.
export default function TerminalPane(props: {
  ws: Workspace;
  paneId: number;
  tabId: number;
  pane: TerminalPaneNode;
}) {
  let el!: HTMLDivElement;

  const isActive = () => {
    const t = props.ws.activeTab();
    return props.ws.activeTabId() === props.tabId && t?.activePaneId === props.paneId;
  };

  onMount(() => {
    mountTerminal(props.paneId, el, {
      cwd: props.pane.cwd,
      onExit: () => props.ws.handleShellExit(props.paneId),
    });
    if (isActive()) focusTerminal(props.paneId);
    onCleanup(() => unmountTerminal(props.paneId));
  });

  createEffect(() => {
    if (isActive()) focusTerminal(props.paneId);
  });

  return (
    <div
      class="term-pane"
      classList={{ active: isActive() }}
      onMouseDown={() => props.ws.activatePane(props.paneId)}
    >
      <div class="term-pane-host" ref={el} />
    </div>
  );
}
