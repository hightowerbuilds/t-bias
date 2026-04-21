import { onMount, onCleanup, createSignal, createEffect, type Component } from "solid-js";
import { XtermHost } from "./terminal/XtermHost";
import "@xterm/xterm/css/xterm.css";
import {
  SPAWN_SHELL_CMD, WRITE_TO_PTY_CMD, RESIZE_PTY_CMD,
  GET_PANE_FOREGROUND_PROCESS_NAME_CMD,
  RESOLVE_EXISTING_DIR_CMD,
  CREATE_SHELL_RECORD_CMD,
  ATTACH_SHELL_RECORD_CMD,
  type ShellRecord,
  type ResolvedDirectory,
  type AppConfig,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;
const { listen } = (window as any).__TAURI__.event;

// ---------------------------------------------------------------------------
// XtermHost cache — preserves terminal state across component remounts
// ---------------------------------------------------------------------------

const hostCache = new Map<number, XtermHost>();

export function destroyTerminalHost(paneId: number) {
  const host = hostCache.get(paneId);
  if (host) {
    host.dispose();
    hostCache.delete(paneId);
  }
}

export function zoomTerminal(paneId: number, delta: number) {
  hostCache.get(paneId)?.zoom(delta);
}

export function resetTerminalZoom(paneId: number) {
  hostCache.get(paneId)?.resetZoom();
}

export interface TerminalViewProps {
  paneId: number;
  config: AppConfig;
  initialCwd?: string;
  shellId?: string;
  initialTitle?: string;
  defaultPersistOnQuit?: boolean;
  isActive: boolean;
  onTitleChange?: (title: string) => void;
  onProcessTitleChange?: (title: string | null) => void;
  onActivity?: () => void;
  onCwdChange?: (cwd: string) => void;
  onShellRecordReady?: (record: ShellRecord) => void;
  onExit?: () => void;
}

const TerminalView: Component<TerminalViewProps> = (props) => {
  let containerRef!: HTMLDivElement;
  let terminal: XtermHost | undefined;
  let processTitlePoll: number | undefined;
  const [terminalReady, setTerminalReady] = createSignal(false);

  onMount(async () => {
    const config = props.config;

    const cached = hostCache.get(props.paneId);
    if (cached) {
      terminal = cached;
      terminal.reattach(containerRef);
    } else {
      terminal = new XtermHost(containerRef, {
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
      hostCache.set(props.paneId, terminal);
    }

    setTerminalReady(true);

    // Wire callbacks
    terminal.onData = (data) => {
      invoke(WRITE_TO_PTY_CMD, { paneId: props.paneId, data });
    };

    terminal.onTitleChange = (title) => {
      props.onTitleChange?.(title);
    };

    terminal.onCwdChange = (cwd) => {
      props.onCwdChange?.(cwd);
    };

    terminal.onResize = (cols, rows) => {
      invoke(RESIZE_PTY_CMD, { paneId: props.paneId, cols, rows });
    };

    // PTY output → xterm.js (xterm handles all VT parsing and rendering)
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
      props.onExit?.();
    });

    // Spawn shell if this is a fresh host (not a reattach)
    if (!cached) {
      const shell = config.shell || undefined;
      const { cols, rows } = terminal.gridSize;
      try {
        let cwd = props.initialCwd;
        if (cwd) {
          const resolution = (await invoke(RESOLVE_EXISTING_DIR_CMD, {
            path: cwd,
          })) as ResolvedDirectory;
          cwd = resolution.resolved_path;
          if (cwd !== props.initialCwd) {
            props.onCwdChange?.(cwd);
          }
        }
        try {
          const shellRecord = props.shellId
            ? (await invoke(ATTACH_SHELL_RECORD_CMD, {
                shellId: props.shellId,
                cwd,
                title: props.initialTitle,
              })) as ShellRecord
            : (await invoke(CREATE_SHELL_RECORD_CMD, {
                cwd,
                shell,
                title: props.initialTitle,
                persistOnQuit: props.defaultPersistOnQuit,
              })) as ShellRecord;
          props.onShellRecordReady?.(shellRecord);
        } catch {}
        await invoke(SPAWN_SHELL_CMD, {
          paneId: props.paneId,
          cols,
          rows,
          shell,
          cwd,
        });
      } catch (err) {
        terminal!.write(`\r\n\x1b[31mFailed to spawn shell: ${err}\x1b[0m\r\n`);
      }
    }

    // Poll foreground process title
    let lastProcessTitle: string | null | undefined;
    const pollForegroundProcessTitle = async () => {
      try {
        const title = (await invoke(
          GET_PANE_FOREGROUND_PROCESS_NAME_CMD,
          { paneId: props.paneId },
        )) as string | null;
        if (title !== lastProcessTitle) {
          lastProcessTitle = title;
          props.onProcessTitleChange?.(title);
        }
      } catch {}
    };

    void pollForegroundProcessTitle();
    processTitlePoll = window.setInterval(() => {
      void pollForegroundProcessTitle();
    }, 1200);

    // ResizeObserver for pane resize / window resize
    const ro = new ResizeObserver(() => terminal?.fit());
    ro.observe(containerRef);

    onCleanup(() => {
      ro.disconnect();
      unlistenOutput();
      unlistenExit();
      if (processTitlePoll !== undefined) window.clearInterval(processTitlePoll);
      terminal?.detach();
    });
  });

  createEffect(() => {
    if (props.isActive && terminalReady()) {
      terminal!.focus();
    }
  });

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: props.config.theme.background,
      }}
    />
  );
};

export default TerminalView;
