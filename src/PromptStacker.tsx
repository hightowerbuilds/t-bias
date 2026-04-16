import {
  createEffect,
  For,
  Show,
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

  createEffect(() => {
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

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        "flex-direction": "column",
        background: isModal() ? "transparent" : props.config.theme.background,
        color: props.config.theme.foreground,
        "font-family": "Menlo, Monaco, 'Courier New', monospace",
        "min-height": "0",
      }}
    >
      <div
        style={{
          padding: isModal() ? "0 0 18px" : "18px 20px 14px",
          "border-bottom": isModal() ? "none" : "1px solid #2a2a2a",
          "flex-shrink": "0",
        }}
      >
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "12px",
            "margin-bottom": "12px",
          }}
        >
          <div>
            <div style={{ "font-size": isModal() ? "18px" : "13px", color: "#d4d4d4" }}>Prompt Stacker</div>
            <div style={{ "font-size": isModal() ? "12px" : "11px", color: "#777", "margin-top": "3px", "line-height": "1.6" }}>
              Capture reusable prompts, keep them organized, and return to the shell when you are done.
            </div>
          </div>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              "flex-shrink": "0",
            }}
          >
            <div style={{ "font-size": "11px", color: "#666" }}>
              {store.prompts().length} saved
            </div>
            <Show when={closeAction()}>
              <button
                onClick={() => void closeAction()?.()}
                style={{
                  background: isModal() ? "#232323" : "#1a1a1a",
                  color: isModal() ? "#d4d4d4" : "#b8c7ea",
                  border: isModal() ? "1px solid #444" : "1px solid #303845",
                  "border-radius": "8px",
                  padding: "7px 10px",
                  "font-family": "inherit",
                  "font-size": "11px",
                  cursor: "pointer",
                }}
              >
                {isModal() ? "Done" : "← Shell"}
              </button>
            </Show>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: "1",
          overflow: "hidden",
          padding: isModal() ? "0" : "14px 18px 18px",
          "box-sizing": "border-box",
          display: "flex",
          "flex-direction": "column",
          gap: "14px",
          "min-height": "0",
        }}
      >
        <div
          style={{
            background: isModal() ? "#121212" : "transparent",
            border: isModal() ? "1px solid #252525" : "none",
            "border-radius": isModal() ? "10px" : "0",
            padding: isModal() ? "16px" : "0",
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
          }}
        >
          <Show when={isModal()}>
            <div style={{ "font-size": "11px", color: "#6f6f6f", "text-transform": "uppercase", "letter-spacing": "0.08em" }}>
              Draft Prompt
            </div>
          </Show>

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
            style={{
              width: "100%",
              height: isModal() ? "180px" : "130px",
              resize: "vertical",
              background: "#111",
              color: props.config.theme.foreground,
              border: "1px solid #333",
              "border-radius": "8px",
              padding: "12px 13px",
              "box-sizing": "border-box",
              "font-family": "inherit",
              "font-size": "12px",
              "line-height": "1.6",
              outline: "none",
            }}
          />

          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              gap: "10px",
            }}
          >
            <Show when={store.error()}>
              <div style={{ color: "#f44747", "font-size": "11px" }}>{store.error()}</div>
            </Show>
            <div style={{ "margin-left": "auto", display: "flex", gap: "8px", "align-items": "center" }}>
              <div style={{ "font-size": "11px", color: "#666" }}>Cmd+Enter to save</div>
              <button
                onClick={() => void savePrompt()}
                disabled={store.saving() || !store.draft().trim()}
                style={{
                  background: store.saving() || !store.draft().trim() ? "#2a2a2a" : "#5b8aff",
                  color: store.saving() || !store.draft().trim() ? "#666" : "#fff",
                  border: "none",
                  "border-radius": "8px",
                  padding: "8px 12px",
                  "font-family": "inherit",
                  "font-size": "11px",
                  cursor: store.saving() || !store.draft().trim() ? "default" : "pointer",
                }}
              >
                {store.saving() ? "Saving..." : "Save Prompt"}
              </button>
            </div>
          </div>
        </div>

        <div
          style={{
            flex: "1",
            background: isModal() ? "#121212" : "transparent",
            border: isModal() ? "1px solid #252525" : "none",
            "border-radius": isModal() ? "10px" : "0",
            padding: isModal() ? "16px" : "0",
            display: "flex",
            "flex-direction": "column",
            gap: "12px",
            "min-height": "0",
          }}
        >
          <Show when={isModal()}>
            <div style={{ "font-size": "11px", color: "#6f6f6f", "text-transform": "uppercase", "letter-spacing": "0.08em" }}>
              Saved Prompts
            </div>
          </Show>

          <Show
            when={store.prompts().length > 0}
            fallback={
              <div
                style={{
                  flex: "1",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  color: "#666",
                  "font-size": "12px",
                }}
              >
                {store.loading() ? "Loading prompts..." : "No saved prompts yet"}
              </div>
            }
          >
            <div style={{ display: "flex", "flex-direction": "column", gap: "10px", overflow: "auto", "padding-right": "4px" }}>
              <For each={store.prompts()}>
                {(prompt) => (
                  <div
                    style={{
                      background: "#151515",
                      border: "1px solid #272727",
                      "border-radius": "10px",
                      padding: "12px 13px",
                      "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.02)",
                    }}
                  >
                    <div style={{ "font-size": "10px", color: "#666", "margin-bottom": "8px" }}>
                      {formatDate(prompt.created_at)}
                    </div>
                    <div
                      style={{
                        "font-size": "12px",
                        "line-height": "1.65",
                        color: "#d4d4d4",
                        "white-space": "pre-wrap",
                        "word-break": "break-word",
                      }}
                    >
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
