import { createSignal, onCleanup, onMount } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { ping } from "../lib/api";
import { openEcho } from "../lib/api";
import { registerHotkeys } from "../lib/hotkeys";

// Phase 0 spine check: proves the three bridges the rest of the app is built on.
export default function Home() {
  const pingQuery = useQuery(() => ({ queryKey: ["ping"], queryFn: ping }));
  const [echo, setEcho] = createSignal("(connecting…)");
  const [hotkey, setHotkey] = createSignal("press ⌘K or ⌘B");

  onMount(() => {
    const ws = openEcho(setEcho);
    ws.addEventListener("open", () => ws.send("hello from webview"));

    const unsub = registerHotkeys({
      "$mod+k": () => setHotkey("⌘K fired ✓"),
      "$mod+b": () => setHotkey("⌘B fired ✓"),
    });

    onCleanup(() => {
      unsub();
      ws.close();
    });
  });

  const httpStatus = () => {
    if (pingQuery.isPending) return "…";
    if (pingQuery.isError) return "ERROR";
    const d = pingQuery.data!;
    return `${d.runtime} @ ${new Date(d.ts).toLocaleTimeString()}`;
  };

  return (
    <section>
      <h1>Phase 0 — spine</h1>
      <p class="sub">
        Deno backend ⇄ SolidJS webview, with TanStack Router/Query and tinykeys.
      </p>
      <ul class="checks">
        <li>
          <span class="tag">HTTP</span> TanStack Query → Deno <code>/api/ping</code>:{" "}
          <b classList={{ ok: !pingQuery.isError, err: pingQuery.isError }}>
            {httpStatus()}
          </b>
        </li>
        <li>
          <span class="tag">WS</span> <code>/ws</code> echo (PTY stream reuses this
          in Phase 1): <b class="ok">{echo()}</b>
        </li>
        <li>
          <span class="tag">KEYS</span> tinykeys: <b class="ok">{hotkey()}</b>
        </li>
      </ul>
    </section>
  );
}
