import { createRoot, createSignal } from "solid-js";
import {
  LIST_PROMPTS_CMD,
  SAVE_PROMPT_CMD,
  type PromptRecord,
} from "./ipc/types";

const { invoke } = (window as any).__TAURI__.core;

export interface PromptStackerStore {
  draft: () => string;
  prompts: () => PromptRecord[];
  saving: () => boolean;
  loading: () => boolean;
  loaded: () => boolean;
  error: () => string | null;
  setDraft: (value: string) => void;
  ensureLoaded: () => Promise<void>;
  reload: () => Promise<void>;
  saveDraft: () => Promise<boolean>;
}

const promptStackerStore = createRoot<PromptStackerStore>(() => {
  const [draft, setDraft] = createSignal("");
  const [prompts, setPrompts] = createSignal<PromptRecord[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const loadPrompts = async (force = false) => {
    if (loading()) return;
    if (loaded() && !force) return;

    setLoading(true);
    setError(null);
    try {
      const items = (await invoke(LIST_PROMPTS_CMD)) as PromptRecord[];
      setPrompts(items);
      setLoaded(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const saveDraft = async () => {
    const text = draft().trim();
    if (!text || saving()) return false;

    setSaving(true);
    setError(null);
    try {
      const saved = (await invoke(SAVE_PROMPT_CMD, { text })) as PromptRecord;
      setPrompts((current) => [saved, ...current]);
      setDraft("");
      setLoaded(true);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    draft,
    prompts,
    saving,
    loading,
    loaded,
    error,
    setDraft,
    ensureLoaded: () => loadPrompts(false),
    reload: () => loadPrompts(true),
    saveDraft,
  };
});

export function usePromptStackerStore() {
  return promptStackerStore;
}
