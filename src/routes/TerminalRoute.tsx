// Placeholder. Phase 1 mounts an xterm.js pane here, streaming a real login
// shell over the /ws bridge, driven by the Rust PTY sidecar.
export default function TerminalRoute() {
  return (
    <section>
      <h2>Terminal</h2>
      <p class="sub">
        Phase 1 lands here: xterm.js pane ⇄ <code>/ws</code> ⇄ Deno supervisor ⇄
        Rust PTY sidecar ⇄ your shell.
      </p>
    </section>
  );
}
