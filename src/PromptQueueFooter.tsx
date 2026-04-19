import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { AppConfig } from "./ipc/types";
import { usePromptStackerStore } from "./promptStackerStore";

export interface PromptQueueFooterProps {
  config: AppConfig;
}

const PromptQueueFooter: Component<PromptQueueFooterProps> = (props) => {
  const store = usePromptStackerStore();
  const [copiedId, setCopiedId] = createSignal<string | null>(null);
  let copiedTimer: number | undefined;

  onMount(() => {
    void store.ensureLoaded();
  });

  onCleanup(() => {
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
  });

  const summarizePrompt = (text: string) => {
    const singleLine = text.trim().replace(/\s+/g, " ");
    return singleLine.length > 56 ? `${singleLine.slice(0, 56).trimEnd()}...` : singleLine;
  };

  const copyPrompt = async (promptId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(promptId);
      if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => setCopiedId(null), 1400);
    } catch {
      // Ignore clipboard failures for now; the queue remains visible.
    }
  };

  return (
    <Show when={store.queuedPrompts().length > 0}>
      <div
        style={{
          "flex-shrink": "0",
          height: "46px",
          background: "var(--bg-input)",
          border: "0",
          "border-top": "1px solid var(--bg-elevated)",
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "0 12px",
          "box-sizing": "border-box",
          overflow: "hidden",
          color: props.config.theme.foreground,
          "font-family": "var(--font-mono)",
        }}
      >
        <div class="section-label" style={{ "white-space": "nowrap", "flex-shrink": "0" }}>
          Queue {store.queuedPrompts().length}
        </div>

        <div style={{ flex: "1", display: "flex", gap: "8px", overflow: "auto", "padding-bottom": "2px" }}>
          <For each={store.queuedPrompts()}>
            {(prompt, index) => {
              const isCopied = () => copiedId() === prompt.id;
              return (
                <button
                  onClick={() => void copyPrompt(prompt.id, prompt.text)}
                  title="Copy prompt to clipboard"
                  style={{
                    background: isCopied() ? "var(--success-bg)" : "var(--bg-panel)",
                    color: isCopied() ? "#d7f3dc" : "#c9c9c9",
                    border: isCopied() ? "1px solid #35633e" : "1px solid #2b2b2b",
                    "border-radius": "var(--radius-pill)",
                    height: "28px",
                    padding: "0 11px",
                    "font-family": "inherit",
                    "font-size": "11px",
                    cursor: "pointer",
                    "white-space": "nowrap",
                    "flex-shrink": "0",
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "7px",
                    "max-width": "320px",
                  }}
                >
                  <span style={{ color: isCopied() ? "#b8e5c0" : "#6f84a8", "font-size": "10px", "flex-shrink": "0" }}>
                    {index() + 1}
                  </span>
                  <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                    {isCopied() ? "Copied" : summarizePrompt(prompt.text)}
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default PromptQueueFooter;
