import { onMount, onCleanup, type Component } from "solid-js";
import { TerminalHost } from "./terminal/TerminalHost";
import {
  SPAWN_SHELL_CMD, WRITE_TO_PTY_CMD, RESIZE_PTY_CMD,
  PTY_OUTPUT_EVENT, PTY_EXIT_EVENT,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;
const { listen } = (window as any).__TAURI__.event;

const TerminalView: Component = () => {
  let containerRef!: HTMLDivElement;
  let textCanvasRef!: HTMLCanvasElement;

  onMount(async () => {
    const terminal = new TerminalHost(textCanvasRef, {
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      scrollbackLimit: 5000,
    });

    const { cols, rows } = terminal.gridSize;

    terminal.onData = (data) => {
      invoke(WRITE_TO_PTY_CMD, { data });
    };

    const unlistenOutput = await listen(PTY_OUTPUT_EVENT, (event: any) => {
      terminal.write(event.payload as string);
    });

    const unlistenExit = await listen(PTY_EXIT_EVENT, () => {
      terminal.write("\r\n[Process exited]\r\n");
    });

    await invoke(SPAWN_SHELL_CMD, { cols, rows });

    terminal.onResize = (cols, rows) => {
      invoke(RESIZE_PTY_CMD, { cols, rows });
    };

    const onWindowResize = () => terminal.fit();
    window.addEventListener("resize", onWindowResize);

    terminal.focus();

    onCleanup(() => {
      window.removeEventListener("resize", onWindowResize);
      unlistenOutput();
      unlistenExit();
      terminal.dispose();
    });
  });

  return (
    <div
      ref={containerRef}
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
