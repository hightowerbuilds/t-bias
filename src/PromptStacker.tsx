import {
  createEffect,
  For,
  Show,
  onMount,
  type Component,
} from "solid-js";
import {
  type AppConfig,
} from "./ipc/types";
import { usePromptStackerStore } from "./promptStackerStore";

export interface PromptStackerViewProps {
  config: AppConfig;
  isActive: boolean;
  shouldFocus?: boolean;
  variant?: "pane" | "modal";
  onClose?: () => void | Promise<void>;
  onBackToShell?: () => void | Promise<void>;
}

const PromptStackerView: Component<PromptStackerViewProps> = (props) => {
  const store = usePromptStackerStore();
  let textareaRef: HTMLTextAreaElement | undefined;
  const isModal = () => props.variant === "modal";
  const closeAction = () => props.onClose ?? props.onBackToShell;

  const focusDraftInput = () => {
    window.requestAnimationFrame(() => {
      if (!textareaRef) return;
      textareaRef.focus();
      const end = textareaRef.value.length;
      textareaRef.setSelectionRange(end, end);
    });
  };

  onMount(() => {
    void store.ensureLoaded();
  });

  createEffect(() => {
    if (!(props.shouldFocus ?? props.isActive)) return;
    focusDraftInput();
  });

  const savePrompt = async () => {
    const saved = await store.saveDraft();
    if (saved) focusDraftInput();
  };

  const formatDate = (createdAt: number) =>
    new Date(createdAt * 1000).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  const canSave = () => !store.saving() && store.draft().trim();

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        "flex-direction": "column",
        background: props.config.theme.background,
        color: props.config.theme.foreground,
        "font-family": "var(--font-mono)",
        "min-height": "0",
        padding: isModal() ? "40px 60px" : "0",
        "box-sizing": "border-box",
      }}
    >
      <div
        style={{
          padding: isModal() ? "0 0 30px" : "18px 20px 14px",
          "border-bottom": "1px solid var(--border)",
          "flex-shrink": "0",
          "margin-bottom": isModal() ? "30px" : "0",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "12px", "margin-bottom": "12px" }}>
          <div>
            <div style={{ "font-size": isModal() ? "24px" : "13px", color: "var(--text-primary)", "font-weight": "500" }}>Prompt Stacker</div>
            <div style={{ "font-size": isModal() ? "13px" : "11px", color: "var(--text-sublabel)", "margin-top": "6px", "line-height": "1.6" }}>
              Capture reusable prompts, keep them organized, and return to the shell when you are done.
            </div>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "16px", "flex-shrink": "0" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", "font-size": "12px", color: "var(--text-dim)" }}>
              <span>{store.prompts().length} saved</span>
              <span>{store.queueIds().length} queued</span>
            </div>
            <Show when={closeAction()}>
              <button
                class="btn btn-secondary"
                onClick={() => void closeAction()?.()}
                style={{
                  padding: "10px 20px",
                  "font-size": "13px",
                  color: "#fff",
                  "font-weight": "500",
                  transition: "background 0.2s",
                }}
              >
                {isModal() ? "Close" : "← Shell"}
              </button>
            </Show>
          </div>
        </div>
      </div>

      <div style={{ flex: "1", overflow: "hidden", display: "flex", "flex-direction": "column", gap: "24px", "min-height": "0" }}>
        <div style={{
          background: "var(--bg-deep)",
          border: "1px solid var(--border-subtle)",
          "border-radius": "var(--radius-lg)",
          padding: "20px",
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
        }}>
          <div class="section-label" style={{ "font-weight": "600", "letter-spacing": "0.1em" }}>
            Draft Prompt
          </div>

          <textarea
            ref={textareaRef}
            value={store.draft()}
            onInput={(e) => store.setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.metaKey && e.key === "Enter") {
                e.preventDefault();
                void savePrompt();
              }
            }}
            placeholder="Write a prompt here..."
            spellcheck={false}
            class="input-field"
            style={{
              width: "100%",
              height: isModal() ? "160px" : "130px",
              resize: "none",
              color: props.config.theme.foreground,
              "border-radius": "var(--radius-md)",
              padding: "14px",
              "box-sizing": "border-box",
              "font-size": "13px",
              "line-height": "1.6",
            }}
          />

          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "10px" }}>
            <Show when={store.error()}>
              <div style={{ color: "var(--error-text)", "font-size": "11px" }}>{store.error()}</div>
            </Show>
            <div style={{ "margin-left": "auto", display: "flex", gap: "12px", "align-items": "center" }}>
              <div style={{ "font-size": "11px", color: "var(--text-dim)" }}>⌘+Enter to save</div>
              <button
                class="btn"
                onClick={() => void savePrompt()}
                disabled={!canSave()}
                style={{
                  background: canSave() ? "var(--accent)" : "var(--border)",
                  color: canSave() ? "#fff" : "var(--text-dim)",
                  padding: "10px 18px",
                  cursor: canSave() ? "pointer" : "default",
                  "font-weight": "500",
                }}
              >
                {store.saving() ? "Saving..." : "Save Prompt"}
              </button>
            </div>
          </div>
        </div>

        <div style={{
          flex: "1",
          background: "var(--bg-deep)",
          border: "1px solid var(--border-subtle)",
          "border-radius": "var(--radius-lg)",
          padding: "20px",
          display: "flex",
          "flex-direction": "column",
          gap: "16px",
          "min-height": "0",
        }}>
          <div class="section-label" style={{ "font-weight": "600", "letter-spacing": "0.1em" }}>
            Saved Prompts
          </div>

          <Show
            when={store.prompts().length > 0}
            fallback={
              <div style={{ flex: "1", display: "flex", "align-items": "center", "justify-content": "center", color: "var(--text-dim)", "font-size": "13px" }}>
                {store.loading() ? "Loading prompts..." : "No saved prompts yet"}
              </div>
            }
          >
            <div style={{ display: "flex", "flex-direction": "column", gap: "12px", overflow: "auto", "padding-right": "8px" }}>
              <For each={store.prompts()}>
                {(prompt) => (
                  <div style={{
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                    "border-radius": "10px",
                    padding: "16px",
                    "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.02)",
                  }}>
                    <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "12px", "margin-bottom": "10px" }}>
                      <div style={{ "font-size": "11px", color: "var(--text-dim)" }}>
                        {formatDate(prompt.created_at)}
                      </div>
                      <button
                        class="btn btn-pill"
                        onClick={() => void store.toggleQueued(prompt.id)}
                        disabled={store.syncingQueue()}
                        style={{
                          background: store.isQueued(prompt.id) ? "var(--queued-bg)" : "var(--border)",
                          color: store.isQueued(prompt.id) ? "var(--queued-text)" : "#9aa3b2",
                          border: store.isQueued(prompt.id) ? "1px solid var(--queued-border)" : "1px solid #3a3a3a",
                          padding: "6px 12px",
                          "font-size": "11px",
                          cursor: store.syncingQueue() ? "default" : "pointer",
                          "flex-shrink": "0",
                        }}
                      >
                        {store.isQueued(prompt.id)
                          ? `Queued ${store.queuePosition(prompt.id) + 1}`
                          : "Add to Queue"}
                      </button>
                    </div>
                    <div style={{ "font-size": "13px", "line-height": "1.7", color: "var(--text-primary)", "white-space": "pre-wrap", "word-break": "break-word" }}>
                      {prompt.text}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default PromptStackerView;
