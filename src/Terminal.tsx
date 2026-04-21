import { onMount, onCleanup, createSignal, createEffect, type Component } from "solid-js";
import { TerminalHost } from "./terminal/TerminalHost";
import {
  SPAWN_SHELL_CMD, WRITE_TO_PTY_CMD, RESIZE_PTY_CMD,
  GET_PANE_FOREGROUND_PROCESS_NAME_CMD,
  GET_FRAME_CMD,
  RESOLVE_EXISTING_DIR_CMD,
  CREATE_SHELL_RECORD_CMD,
  ATTACH_SHELL_RECORD_CMD,
  type ShellRecord,
  type ResolvedDirectory,
  type AppConfig,
  type ScreenFrame,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;
const { listen } = (window as any).__TAURI__.event;

// ---------------------------------------------------------------------------
// TerminalHost cache — preserves screen state across component remounts
// ---------------------------------------------------------------------------
// When the pane tree restructures (e.g. splits), Solid's Switch/Match tears
// down the old TerminalView and mounts a new one for the same pane ID. Without
// this cache, the new component would create a fresh TerminalHost with a blank
// screen, even though the PTY is still alive.
//
// On unmount the host is detached (DOM cleanup, timers stopped) but its core
// state (screen buffer, scrollback, glyph atlas) is preserved. On remount the
// host is reattached to the new canvas element and redrawn.
// ---------------------------------------------------------------------------

const hostCache = new Map<number, TerminalHost>();

/** Permanently destroy a cached TerminalHost. Call when the PTY is closed. */
export function destroyTerminalHost(paneId: number) {
  const host = hostCache.get(paneId);
  if (host) {
    host.dispose();
    hostCache.delete(paneId);
  }
}

export interface TerminalViewProps {
  /** Unique pane ID — used as the PTY identifier and event-name suffix. */
  paneId: number;
  config: AppConfig;
  initialCwd?: string;
  shellId?: string;
  initialTitle?: string;
  defaultPersistOnQuit?: boolean;
  /** Whether this pane currently has keyboard focus. */
  isActive: boolean;
  /** Called when the shell emits an OSC title change. */
  onTitleChange?: (title: string) => void;
  /** Called when the foreground process in the PTY changes. */
  onProcessTitleChange?: (title: string | null) => void;
  /** Called when output arrives while the pane is not active. */
  onActivity?: () => void;
  /** Called when the shell reports a working directory change (OSC 7). */
  onCwdChange?: (cwd: string) => void;
  /** Called when a durable shell record is created or reattached. */
  onShellRecordReady?: (record: ShellRecord) => void;
  /** Called when the PTY process exits. */
  onExit?: () => void;
}

const TerminalView: Component<TerminalViewProps> = (props) => {
  let textCanvasRef!: HTMLCanvasElement;
  let terminal: TerminalHost | undefined;
  let processTitlePoll: number | undefined;
  const [terminalReady, setTerminalReady] = createSignal(false);

  onMount(async () => {
    const config = props.config;

    // Check for a cached host from a previous mount (e.g. after a split).
    const cached = hostCache.get(props.paneId);
    if (cached) {
      terminal = cached;
      terminal.reattach(textCanvasRef);
    } else {
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
      hostCache.set(props.paneId, terminal);
    }

    // Signal that the terminal object exists so focus/resize can fire.
    setTerminalReady(true);

    // Always (re-)wire callbacks — they reference props from this mount cycle.
    terminal.onData = (data) => {
      invoke(WRITE_TO_PTY_CMD, { paneId: props.paneId, data });
    };

    terminal.core.onClipboard = (text) => {
      navigator.clipboard.writeText(text);
    };

    terminal.core.onClipboardRead = async () => {
      // Read via Tauri clipboard plugin to avoid WebKit permission prompts.
      const tauri = (window as any).__TAURI__;
      if (tauri?.core?.invoke) {
        try {
          const text = await tauri.core.invoke("plugin:clipboard-manager|read_text");
          return typeof text === "string" ? text : null;
        } catch { /* fall through */ }
      }
      if (navigator.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
      return null;
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

    // PTY event listeners — registered per mount cycle.
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
      props.onExit?.();
    });

    // Rust frame rendering — when the Rust VT backend signals a new frame,
    // fetch it via IPC and render it directly to canvas, bypassing the JS
    // VT pipeline. This is the fast path for TUI apps.
    let rustFrameQueued = false;
    const unlistenFrame = await listen(`frame-ready-${props.paneId}`, () => {
      if (rustFrameQueued) return;
      rustFrameQueued = true;
      requestAnimationFrame(async () => {
        rustFrameQueued = false;
        try {
          const frame = (await invoke(GET_FRAME_CMD, { paneId: props.paneId })) as ScreenFrame | null;
          if (frame && terminal) {
            terminal.drawFrame(frame);
            if (frame.title) {
              props.onTitleChange?.(frame.title);
            }
          }
        } catch {
          // Frame fetch failed — JS pipeline handles rendering
        }
      });
    });

    // Only spawn a shell if this is a fresh host (not a reattach).
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
        } catch {
          // If shell logging fails, keep the terminal usable.
        }
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
      } catch {
        // Ignore polling failures; the shell title path still works.
      }
    };

    void pollForegroundProcessTitle();
    processTitlePoll = window.setInterval(() => {
      void pollForegroundProcessTitle();
    }, 1200);

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
      unlistenFrame();
      if (processTitlePoll !== undefined) window.clearInterval(processTitlePoll);
      // Detach (not dispose) — the host stays in hostCache so it can be
      // reattached if this pane remounts after a tree restructure.
      // Permanent disposal happens via destroyTerminalHost() when the PTY
      // is actually closed by App.tsx.
      terminal?.detach();
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
