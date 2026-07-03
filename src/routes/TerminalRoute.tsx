import { createSignal, onCleanup, onMount } from "solid-js";
import { XtermHost } from "../terminal/XtermHost";

// Phase 1 vertical slice: an xterm.js pane wired to a real login shell over
// the /pty WebSocket, driven by the Rust PTY sidecar.
export default function TerminalRoute() {
  let el!: HTMLDivElement;
  const [status, setStatus] = createSignal("connecting…");

  onMount(() => {
    const host = new XtermHost(el);
    const initial = host.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/pty?pane=1&cols=${initial.cols}&rows=${initial.rows}`,
    );
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setStatus(`live · ${host.term.cols}×${host.term.rows}`);
      host.focus();
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) host.write(new Uint8Array(e.data));
    };
    ws.onclose = () => setStatus("shell exited");
    ws.onerror = () => setStatus("connection error");

    const dataSub = host.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "i", d }));
      }
    });

    const sendResize = () => {
      const s = host.fit();
      setStatus(`live · ${s.cols}×${s.rows}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "r", c: s.cols, r: s.rows }));
      }
    };

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(el);
    window.addEventListener("resize", sendResize);

    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", sendResize);
      dataSub.dispose();
      ws.close();
      host.dispose();
    });
  });

  return (
    <div class="term-page">
      <div class="term-status">
        <span class="tag">PTY</span> pane 1 · <b class="ok">{status()}</b>
      </div>
      <div class="term-host" ref={el}></div>
    </div>
  );
}
