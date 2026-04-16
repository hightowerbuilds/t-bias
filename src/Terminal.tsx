import { onMount, onCleanup, createSignal, createEffect, type Component } from "solid-js";
import { TerminalHost } from "./terminal/TerminalHost";
import {
  SPAWN_SHELL_CMD, WRITE_TO_PTY_CMD, RESIZE_PTY_CMD, CLOSE_PANE_CMD,
  type AppConfig,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;
const { listen } = (window as any).__TAURI__.event;

export interface TerminalViewProps {
  /** Unique pane ID — used as the PTY identifier and event-name suffix. */
  paneId: number;
  config: AppConfig;
  /** Whether this pane currently has keyboard focus. */
  isActive: boolean;
  /** Called when the shell emits an OSC title change. */
  onTitleChange?: (title: string) => void;
  /** Called when output arrives while the pane is not active. */
  onActivity?: () => void;
  /** Called when the shell reports a working directory change (OSC 7). */
  onCwdChange?: (cwd: string) => void;
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

    // Signal that the terminal object exists so focus/resize can fire.
    setTerminalReady(true);

    const { cols, rows } = terminal.gridSize;

    terminal.onData = (data) => {
      invoke(WRITE_TO_PTY_CMD, { paneId: props.paneId, data });
    };

    terminal.core.onClipboard = (text) => {
      navigator.clipboard.writeText(text);
    };

    terminal.onTitleChange = (title) => {
      props.onTitleChange?.(title);
    };

    terminal.onCwdChange = (cwd) => {
      props.onCwdChange?.(cwd);
    };

    const unlistenOutput = await listen(
      `pty-output-${props.paneId}`,
      (event: any) => {
        terminal!.write(event.payload as string);
        if (!props.isActive) {
          props.onActivity?.();
        }
      },
    );

    const unlistenExit = await listen(`pty-exit-${props.paneId}`, () => {
      terminal!.write("\r\n[Process exited]\r\n");
    });

    const shell = config.shell || undefined;
    try {
      await invoke(SPAWN_SHELL_CMD, { paneId: props.paneId, cols, rows, shell });
    } catch (err) {
      terminal!.write(`\r\n\x1b[31mFailed to spawn shell: ${err}\x1b[0m\r\n`);
    }

    terminal.onResize = (cols, rows) => {
      invoke(RESIZE_PTY_CMD, { paneId: props.paneId, cols, rows });
    };

    // ResizeObserver keeps each pane's grid in sync with its container size.
    // This covers both window resizes and pane-divider drags without needing
    // a global window.resize handler.
    const ro = new ResizeObserver(() => terminal?.fit());
    const container = textCanvasRef.parentElement;
    if (container) ro.observe(container);

    onCleanup(() => {
      ro.disconnect();
      unlistenOutput();
      unlistenExit();
      terminal?.dispose();
      invoke(CLOSE_PANE_CMD, { paneId: props.paneId }).catch(() => {});
    });
  });

  // Focus the terminal whenever this pane becomes active.
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
        background: props.config.theme.background,
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
