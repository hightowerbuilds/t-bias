import {
  createEffect,
  createSignal,
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

// ---------------------------------------------------------------------------
// PromptCard — individual prompt with edit, delete, duplicate, queue toggle
// ---------------------------------------------------------------------------

interface PromptCardProps {
  prompt: { id: string; text: string; created_at: number };
  store: ReturnType<typeof usePromptStackerStore>;
  formatDate: (ts: number) => string;
  config: AppConfig;
}

const PromptCard: Component<PromptCardProps> = (cardProps) => {
  const [editing, setEditing] = createSignal(false);
  const [editText, setEditText] = createSignal("");
  const { store } = cardProps;
  const queued = () => store.isQueued(cardProps.prompt.id);

  const startEdit = () => {
    setEditText(cardProps.prompt.text);
    setEditing(true);
  };

  const commitEdit = async () => {
    const ok = await store.editPrompt(cardProps.prompt.id, editText());
    if (ok) setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  const actionBtnStyle = {
    background: "none",
    border: "none",
    color: "#777",
    cursor: "pointer",
    padding: "2px 6px",
    "font-size": "11px",
    "font-family": "inherit",
    "border-radius": "0",
  };

  return (
    <div style={{
      background: "var(--bg-surface)",
      border: queued() ? "1px solid var(--queued-border)" : "1px solid var(--border)",
      "border-left": queued() ? "3px solid var(--queued-text)" : "1px solid var(--border)",
      "border-radius": "0",
      padding: "16px",
      "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.02)",
      transition: "border-color 0.15s ease",
    }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px", "margin-bottom": "10px" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
          <div style={{ "font-size": "11px", color: "var(--text-dim)" }}>
            {cardProps.formatDate(cardProps.prompt.created_at)}
          </div>
          <Show when={!editing()}>
            <button onClick={startEdit} style={actionBtnStyle} title="Edit">Edit</button>
            <button onClick={() => void store.duplicatePrompt(cardProps.prompt.id)} style={actionBtnStyle} title="Duplicate">Dup</button>
            <button
              onClick={() => void store.deletePrompt(cardProps.prompt.id)}
              style={{ ...actionBtnStyle, color: "#a55" }}
              title="Delete"
            >
              Del
            </button>
          </Show>
        </div>
        <button
          class="btn btn-pill"
          onClick={() => void store.toggleQueued(cardProps.prompt.id)}
          disabled={store.syncingQueue()}
          style={{
            background: queued() ? "var(--queued-bg)" : "var(--border)",
            color: queued() ? "var(--queued-text)" : "#9aa3b2",
            border: queued() ? "1px solid var(--queued-border)" : "1px solid #3a3a3a",
            padding: "6px 12px",
            "font-size": "11px",
            cursor: store.syncingQueue() ? "default" : "pointer",
            "flex-shrink": "0",
          }}
        >
          {queued()
            ? `Queued #${store.queuePosition(cardProps.prompt.id) + 1}`
            : "Add to Queue"}
        </button>
      </div>

      <Show
        when={editing()}
        fallback={
          <div>
            <div style={{ "font-size": "13px", "line-height": "1.7", color: "var(--text-primary)", "white-space": "pre-wrap", "word-break": "break-word" }}>
              {cardProps.prompt.text}
            </div>
            <Show when={cardProps.prompt.tags?.length > 0}>
              <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap", "margin-top": "8px" }}>
                <For each={cardProps.prompt.tags}>
                  {(tag) => (
                    <span style={{
                      background: "var(--bg-elevated)",
                      color: "var(--text-dim)",
                      padding: "2px 8px",
                      "border-radius": "0",
                      "font-size": "10px",
                    }}>
                      {tag}
                    </span>
                  )}
                </For>
              </div>
            </Show>
          </div>
        }
      >
        <textarea
          value={editText()}
          onInput={(e) => setEditText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.metaKey && e.key === "Enter") { e.preventDefault(); void commitEdit(); }
            if (e.key === "Escape") cancelEdit();
          }}
          class="input-field"
          style={{
            width: "100%",
            height: "100px",
            resize: "vertical",
            color: cardProps.config.theme.foreground,
            "border-radius": "0",
            padding: "10px",
            "box-sizing": "border-box",
            "font-size": "13px",
            "line-height": "1.6",
            "margin-bottom": "8px",
          }}
        />
        <input
          type="text"
          placeholder="Tags (comma-separated)"
          value={(cardProps.prompt.tags ?? []).join(", ")}
          onChange={(e) => {
            const tags = e.currentTarget.value.split(",").map(t => t.trim()).filter(Boolean);
            void store.setTags(cardProps.prompt.id, tags);
          }}
          class="input-field"
          style={{
            width: "100%",
            height: "28px",
            padding: "0 10px",
            "font-size": "11px",
            "border-radius": "0",
            color: cardProps.config.theme.foreground,
            "margin-bottom": "8px",
            "box-sizing": "border-box",
          }}
        />
        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
          <button class="btn btn-secondary" onClick={cancelEdit} style={{ padding: "6px 14px", "font-size": "12px" }}>
            Cancel
          </button>
          <button
            class="btn"
            onClick={() => void commitEdit()}
            disabled={!editText().trim()}
            style={{ padding: "6px 14px", "font-size": "12px", background: "var(--accent)", color: "#fff" }}
          >
            Save
          </button>
        </div>
      </Show>
    </div>
  );
};

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

  const exportLibrary = async () => {
    const json = await store.exportPrompts();
    if (json) {
      await navigator.clipboard.writeText(json);
    }
  };

  const importLibrary = async () => {
    try {
      const json = await navigator.clipboard.readText();
      if (json) await store.importPrompts(json);
    } catch { /* clipboard unavailable */ }
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
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "16px", "flex-shrink": "0" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", "font-size": "12px", color: "var(--text-dim)" }}>
              <span>{store.prompts().length} saved</span>
              <span>{store.queueIds().length} queued</span>
              <button
                onClick={() => void exportLibrary()}
                title="Export prompts to clipboard (JSON)"
                style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", "font-size": "11px", padding: "2px 6px" }}
              >
                Export
              </button>
              <button
                onClick={() => void importLibrary()}
                title="Import prompts from clipboard (JSON)"
                style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", "font-size": "11px", padding: "2px 6px" }}
              >
                Import
              </button>
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
          "border-radius": "0",
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
              "border-radius": "0",
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
          "border-radius": "0",
          padding: "20px",
          display: "flex",
          "flex-direction": "column",
          gap: "16px",
          "min-height": "0",
        }}>
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <div class="section-label" style={{ "font-weight": "600", "letter-spacing": "0.1em", "flex-shrink": "0" }}>
              Saved Prompts
            </div>
            <Show when={store.prompts().length > 5}>
              <input
                type="text"
                placeholder="Search prompts..."
                value={store.searchFilter()}
                onInput={(e) => store.setSearchFilter(e.currentTarget.value)}
                class="input-field"
                style={{
                  flex: "1",
                  height: "28px",
                  padding: "0 10px",
                  "font-size": "12px",
                  "border-radius": "0",
                  color: props.config.theme.foreground,
                }}
              />
            </Show>
            <Show when={store.allTags().length > 0}>
              <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
                <button
                  onClick={() => store.setTagFilter("")}
                  style={{
                    background: !store.tagFilter() ? "var(--accent)" : "var(--bg-elevated)",
                    color: !store.tagFilter() ? "#fff" : "var(--text-dim)",
                    border: "none",
                    "border-radius": "0",
                    padding: "2px 10px",
                    "font-size": "10px",
                    cursor: "pointer",
                    "font-family": "inherit",
                  }}
                >
                  All
                </button>
                <For each={store.allTags()}>
                  {(tag) => (
                    <button
                      onClick={() => store.setTagFilter(store.tagFilter() === tag ? "" : tag)}
                      style={{
                        background: store.tagFilter() === tag ? "var(--accent)" : "var(--bg-elevated)",
                        color: store.tagFilter() === tag ? "#fff" : "var(--text-dim)",
                        border: "none",
                        "border-radius": "0",
                        padding: "2px 10px",
                        "font-size": "10px",
                        cursor: "pointer",
                        "font-family": "inherit",
                      }}
                    >
                      {tag}
                    </button>
                  )}
                </For>
              </div>
            </Show>
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
              <For each={store.filteredPrompts()}>
                {(prompt) => <PromptCard prompt={prompt} store={store} formatDate={formatDate} config={props.config} />}
              </For>
              <Show when={store.searchFilter() && store.filteredPrompts().length === 0}>
                <div style={{ color: "var(--text-dim)", "font-size": "13px", "text-align": "center", padding: "20px" }}>
                  No prompts match "{store.searchFilter()}"
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default PromptStackerView;
