import { tinykeys } from "tinykeys";

// Thin wrapper over tinykeys. Keys use tinykeys syntax, e.g. "$mod+k"
// ($mod = Cmd on macOS, Ctrl elsewhere). Replaces the old hand-rolled
// keybinding matcher. Returns an unsubscribe function.
export function registerHotkeys(
  handlers: Record<string, (e: KeyboardEvent) => void>,
): () => void {
  const wrapped = Object.fromEntries(
    Object.entries(handlers).map(([combo, fn]) => [
      combo,
      (e: KeyboardEvent) => {
        e.preventDefault();
        fn(e);
      },
    ]),
  );
  return tinykeys(window, wrapped);
}
