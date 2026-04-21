import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { WRITE_TO_PTY_CMD, type AppConfig } from "./ipc/types";
import { usePromptStackerStore } from "./promptStackerStore";

const { invoke } = (window as any).__TAURI__.core;

export interface PromptQueueFooterProps {
  config: AppConfig;
  /** Active pane ID — used for "send to shell" when the active pane is a terminal. */
  activePaneId?: number;
  /** Whether the active pane is a terminal (enables "send to shell"). */
  activeIsTerminal?: boolean;
}

const PromptQueueFooter: Component<PromptQueueFooterProps> = (props) => {
  const store = usePromptStackerStore();
  const [copiedId, setCopiedId] = createSignal<string | null>(null);
  const [sentId, setSentId] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal(false);
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  let copiedTimer: number | undefined;
  let sentTimer: number | undefined;
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    void store.ensureLoaded();
  });

  onCleanup(() => {
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    if (sentTimer !== undefined) window.clearTimeout(sentTimer);
  });

  const summarizePrompt = (text: string) => {
    const words = text.trim().replace(/\s+/g, " ").split(" ");
    return words.length > 5 ? words.slice(0, 5).join(" ") + "..." : words.join(" ");
  };

  const canSendToShell = () => props.activeIsTerminal && props.activePaneId != null;

  const copyPrompt = async (promptId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(promptId);
      if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => setCopiedId(null), 1400);
    } catch {
      // Ignore clipboard failures; the queue remains visible.
    }
  };

  const sendToShell = async (promptId: string, text: string) => {
    if (!canSendToShell()) return;
    try {
      await invoke(WRITE_TO_PTY_CMD, { paneId: props.activePaneId, data: text });
      setSentId(promptId);
      if (sentTimer !== undefined) window.clearTimeout(sentTimer);
      sentTimer = window.setTimeout(() => setSentId(null), 1400);
    } catch {
      // Fall back to clipboard copy on failure.
      await copyPrompt(promptId, text);
    }
  };

  const feedbackFor = (promptId: string) => {
    if (sentId() === promptId) return "sent";
    if (copiedId() === promptId) return "copied";
    return null;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const queued = store.queuedPrompts();
    if (queued.length === 0) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, queued.length - 1));
      focusButton();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
      focusButton();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = focusedIndex();
      if (idx >= 0 && idx < queued.length) {
        if (e.shiftKey && canSendToShell()) {
          void sendToShell(queued[idx].id, queued[idx].text);
        } else {
          void copyPrompt(queued[idx].id, queued[idx].text);
        }
      }
    } else if (e.key === " ") {
      e.preventDefault();
      const idx = focusedIndex();
      if (idx >= 0 && idx < queued.length) {
        void copyPrompt(queued[idx].id, queued[idx].text);
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const idx = focusedIndex();
      if (idx >= 0 && idx < queued.length) {
        void store.removeFromQueue(queued[idx].id);
        setFocusedIndex((i) => Math.min(i, queued.length - 2));
      }
    }
  };

  const focusButton = () => {
    requestAnimationFrame(() => {
      const buttons = containerRef?.querySelectorAll<HTMLButtonElement>("[data-queue-item]");
      const idx = focusedIndex();
      if (buttons && idx >= 0 && idx < buttons.length) {
        buttons[idx].focus();
      }
    });
  };

  const hasQueue = () => store.queuedPrompts().length > 0;

  return (
    <Show when={hasQueue()}>
      <div
        ref={containerRef}
        onKeyDown={handleKeyDown}
        style={{
          "flex-shrink": "0",
          background: "var(--bg-input)",
          border: "0",
          "border-top": "1px solid var(--bg-elevated)",
          display: "flex",
          "align-items": "flex-start",
          gap: "8px",
          padding: "8px 12px",
          height: collapsed() ? "32px" : "88px",
          "box-sizing": "border-box",
          overflow: "hidden",
          color: props.config.theme.foreground,
          "font-family": "var(--font-mono)",
          transition: "height 0.15s ease",
        }}
      >
        {/* Collapse toggle + label */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed() ? "Expand queue" : "Collapse queue"}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            padding: "2px 4px",
            "font-size": "10px",
            "flex-shrink": "0",
            "font-family": "inherit",
          }}
        >
          {collapsed() ? "▸" : "▾"}
        </button>

        <div
          class="section-label"
          style={{ "white-space": "nowrap", "flex-shrink": "0", cursor: "pointer" }}
          onClick={() => setCollapsed((c) => !c)}
        >
          Queue {store.queuedPrompts().length}
        </div>

        {/* Queue items (hidden when collapsed) */}
        <Show when={!collapsed()}>
          <div style={{ flex: "1", display: "flex", "flex-wrap": "wrap", gap: "6px", overflow: "auto", "padding": "4px 0", "align-items": "center", "align-content": "flex-start" }}>
            <For each={store.queuedPrompts()}>
              {(prompt, index) => {
                const fb = () => feedbackFor(prompt.id);
                const isFocused = () => focusedIndex() === index();
                return (
                  <div
                    style={{
                      display: "inline-flex",
                      "align-items": "center",
                      "flex-shrink": "0",
                      "max-width": "320px",
                      gap: "0",
                    }}
                  >
                    {/* Move left */}
                    <Show when={index() > 0}>
                      <button
                        onClick={() => void store.moveInQueue(prompt.id, -1)}
                        title="Move left"
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-dim)",
                          cursor: "pointer",
                          padding: "0 2px",
                          "font-size": "9px",
                          "line-height": "1",
                          "flex-shrink": "0",
                        }}
                      >
                        ◂
                      </button>
                    </Show>

                    {/* Prompt pill */}
                    <button
                      data-queue-item
                      onClick={(e) => {
                        if (e.shiftKey && canSendToShell()) {
                          void sendToShell(prompt.id, prompt.text);
                        } else {
                          void copyPrompt(prompt.id, prompt.text);
                        }
                      }}
                      onFocus={() => setFocusedIndex(index())}
                      title={canSendToShell() ? "Click to copy, Shift+click to send to shell" : "Copy prompt to clipboard"}
                      style={{
                        background: fb() === "sent"
                          ? "#1a3a4a"
                          : fb() === "copied"
                            ? "var(--success-bg)"
                            : "var(--bg-panel)",
                        color: fb() === "sent"
                          ? "#7ad4f0"
                          : fb() === "copied"
                            ? "#d7f3dc"
                            : "#c9c9c9",
                        border: fb() === "sent"
                          ? "1px solid #2a5a6a"
                          : fb() === "copied"
                            ? "1px solid #35633e"
                            : isFocused()
                              ? "1px solid var(--accent)"
                              : "1px solid #2b2b2b",
                        "border-radius": "var(--radius-pill)",
                        height: "28px",
                        padding: "0 8px 0 11px",
                        "font-family": "inherit",
                        "font-size": "11px",
                        cursor: "pointer",
                        "white-space": "nowrap",
                        display: "inline-flex",
                        "align-items": "center",
                        gap: "6px",
                        outline: "none",
                      }}
                    >
                      <span style={{ color: fb() ? "inherit" : "#6f84a8", "font-size": "10px", "flex-shrink": "0" }}>
                        {index() + 1}
                      </span>
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {fb() === "sent" ? "Sent" : fb() === "copied" ? "Copied" : summarizePrompt(prompt.text)}
                      </span>

                      {/* Remove button */}
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          void store.removeFromQueue(prompt.id);
                        }}
                        title="Remove from queue"
                        style={{
                          color: "#666",
                          cursor: "pointer",
                          "font-size": "13px",
                          "line-height": "1",
                          padding: "0 2px",
                          "flex-shrink": "0",
                          "margin-left": "2px",
                        }}
                        onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "#e06c6c"; }}
                        onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "#666"; }}
                      >
                        ×
                      </span>
                    </button>

                    {/* Move right */}
                    <Show when={index() < store.queuedPrompts().length - 1}>
                      <button
                        onClick={() => void store.moveInQueue(prompt.id, 1)}
                        title="Move right"
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-dim)",
                          cursor: "pointer",
                          padding: "0 2px",
                          "font-size": "9px",
                          "line-height": "1",
                          "flex-shrink": "0",
                        }}
                      >
                        ▸
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Clear queue button */}
          <button
            onClick={() => void store.clearQueue()}
            title="Clear all queued prompts"
            style={{
              background: "none",
              border: "1px solid #333",
              "border-radius": "var(--radius-pill)",
              color: "#888",
              cursor: "pointer",
              padding: "4px 10px",
              "font-family": "inherit",
              "font-size": "10px",
              "flex-shrink": "0",
              "white-space": "nowrap",
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "#e06c6c"; (e.target as HTMLElement).style.borderColor = "#633535"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "#888"; (e.target as HTMLElement).style.borderColor = "#333"; }}
          >
            Clear
          </button>
        </Show>
      </div>
    </Show>
  );
};

export default PromptQueueFooter;
