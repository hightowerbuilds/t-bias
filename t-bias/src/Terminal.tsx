import { onMount, onCleanup, createSignal, createEffect, type Component } from "solid-js";
import { TerminalHost } from "./terminal/TerminalHost";
import {
  SPAWN_SHELL_CMD, WRITE_TO_PTY_CMD, RESIZE_PTY_CMD, CLOSE_TAB_CMD,
  type AppConfig,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;
const { listen } = (window as any).__TAURI__.event;

export interface TerminalViewProps {
  tabId: number;
  config: AppConfig;
  /** Whether this tab is currently visible and active. */
  isActive: boolean;
  /** Called when the shell emits an OSC title change. */
  onTitleChange?: (title: string) => void;
  /** Called when the terminal receives output while not active (for activity dot). */
  onActivity?: () => void;
}

const TerminalView: Component<TerminalViewProps> = (props) => {
  let textCanvasRef!: HTMLCanvasElement;
  let terminal: TerminalHost | undefined;
  const [terminalReady, setTerminalReady] = createSignal(false);

  onMount(async () => {
    const config = props.config;

    terminal = new TerminalHost(textCanvasRef, {
      fontSize: config.font.size,
      fontFamily: config.font.family,
      scrollbackLimit: config.scrollback_limit,
      padding: config.padding,
      cursorStyle: config.cursor.style,
      cursorBlink: config.cursor.blink,
      theme: {
        background: config.theme.background,
        foreground: config.theme.foreground,
        cursor: config.theme.cursor,
        selectionBg: config.theme.selection_bg,
        ansi: config.theme.ansi,
      },
    });

    // Signal that the terminal object exists so the focus effect can fire.
    setTerminalReady(true);

    const { cols, rows } = terminal.gridSize;

    terminal.onData = (data) => {
      invoke(WRITE_TO_PTY_CMD, { tab_id: props.tabId, data });
    };

    terminal.core.onClipboard = (text) => {
      navigator.clipboard.writeText(text);
    };

    terminal.onTitleChange = (title) => {
      props.onTitleChange?.(title);
    };

    const unlistenOutput = await listen(
      `pty-output-${props.tabId}`,
      (event: any) => {
        terminal!.write(event.payload as string);
        if (!props.isActive) {
          props.onActivity?.();
        }
      },
    );

    const unlistenExit = await listen(`pty-exit-${props.tabId}`, () => {
      terminal!.write("\r\n[Process exited]\r\n");
    });

    const shell = config.shell || undefined;
    await invoke(SPAWN_SHELL_CMD, { tab_id: props.tabId, cols, rows, shell });

    terminal.onResize = (cols, rows) => {
      invoke(RESIZE_PTY_CMD, { tab_id: props.tabId, cols, rows });
    };

    const onWindowResize = () => terminal?.fit();
    window.addEventListener("resize", onWindowResize);

    onCleanup(() => {
      window.removeEventListener("resize", onWindowResize);
      unlistenOutput();
      unlistenExit();
      terminal?.dispose();
      invoke(CLOSE_TAB_CMD, { tab_id: props.tabId }).catch(() => {});
    });
  });

  // Focus the terminal whenever this tab becomes active.
  createEffect(() => {
    if (props.isActive && terminalReady()) {
      terminal!.focus();
    }
  });

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Layer 0: Text + Backgrounds — the IRenderer draws here */}
      <canvas
        ref={textCanvasRef}
        style={{
          position: "absolute",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      {/* Layers 1 & 2 (selection + cursor) created dynamically by TerminalHost */}
    </div>
  );
};

export default TerminalView;
