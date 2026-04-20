import { createRoot, createSignal } from "solid-js";
import {
  GET_PROMPT_STACKER_STATE_CMD,
  SAVE_PROMPT_CMD,
  EDIT_PROMPT_CMD,
  DELETE_PROMPT_CMD,
  DUPLICATE_PROMPT_CMD,
  SET_PROMPT_QUEUE_CMD,
  SET_PROMPT_TAGS_CMD,
  EXPORT_PROMPTS_CMD,
  IMPORT_PROMPTS_CMD,
  type PromptRecord,
  type PromptStackerState,
} from "./ipc/types";

export interface PromptStackerStore {
  draft: () => string;
  prompts: () => PromptRecord[];
  queueIds: () => string[];
  queuedPrompts: () => PromptRecord[];
  saving: () => boolean;
  syncingQueue: () => boolean;
  loading: () => boolean;
  loaded: () => boolean;
  error: () => string | null;
  setDraft: (value: string) => void;
  ensureLoaded: () => Promise<void>;
  reload: () => Promise<void>;
  saveDraft: () => Promise<boolean>;
  isQueued: (promptId: string) => boolean;
  queuePosition: (promptId: string) => number;
  toggleQueued: (promptId: string) => Promise<void>;
  removeFromQueue: (promptId: string) => Promise<void>;
  clearQueue: () => Promise<void>;
  moveInQueue: (promptId: string, delta: number) => Promise<void>;
  /** Return the first queued prompt's text and remove it from the queue. */
  advanceQueue: () => Promise<string | null>;
  editPrompt: (promptId: string, text: string) => Promise<boolean>;
  deletePrompt: (promptId: string) => Promise<void>;
  duplicatePrompt: (promptId: string) => Promise<void>;
  searchFilter: () => string;
  setSearchFilter: (value: string) => void;
  filteredPrompts: () => PromptRecord[];
  setTags: (promptId: string, tags: string[]) => Promise<boolean>;
  tagFilter: () => string;
  setTagFilter: (tag: string) => void;
  allTags: () => string[];
  exportPrompts: () => Promise<string | null>;
  importPrompts: (json: string) => Promise<boolean>;
}

export interface PromptStackerClient {
  getState: () => Promise<PromptStackerState>;
  savePrompt: (text: string) => Promise<PromptRecord>;
  editPrompt: (promptId: string, text: string) => Promise<PromptRecord>;
  deletePrompt: (promptId: string) => Promise<PromptStackerState>;
  duplicatePrompt: (promptId: string) => Promise<PromptRecord>;
  setQueue: (queue: string[]) => Promise<PromptStackerState>;
  setTags: (promptId: string, tags: string[]) => Promise<PromptRecord>;
  exportPrompts: () => Promise<string>;
  importPrompts: (json: string) => Promise<PromptStackerState>;
}

function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("Tauri invoke is unavailable");
  }
  return invoke(command, args) as Promise<T>;
}

const defaultPromptStackerClient: PromptStackerClient = {
  getState: () => invokeTauri<PromptStackerState>(GET_PROMPT_STACKER_STATE_CMD),
  savePrompt: (text) => invokeTauri<PromptRecord>(SAVE_PROMPT_CMD, { text }),
  editPrompt: (promptId, text) => invokeTauri<PromptRecord>(EDIT_PROMPT_CMD, { promptId, text }),
  deletePrompt: (promptId) => invokeTauri<PromptStackerState>(DELETE_PROMPT_CMD, { promptId }),
  duplicatePrompt: (promptId) => invokeTauri<PromptRecord>(DUPLICATE_PROMPT_CMD, { promptId }),
  setQueue: (queue) => invokeTauri<PromptStackerState>(SET_PROMPT_QUEUE_CMD, { queue }),
  setTags: (promptId, tags) => invokeTauri<PromptRecord>(SET_PROMPT_TAGS_CMD, { promptId, tags }),
  exportPrompts: () => invokeTauri<string>(EXPORT_PROMPTS_CMD),
  importPrompts: (json) => invokeTauri<PromptStackerState>(IMPORT_PROMPTS_CMD, { json }),
};

export function createPromptStackerStore(client: PromptStackerClient = defaultPromptStackerClient) {
  return createRoot<PromptStackerStore>(() => {
    const [draft, setDraft] = createSignal("");
    const [prompts, setPrompts] = createSignal<PromptRecord[]>([]);
    const [queueIds, setQueueIds] = createSignal<string[]>([]);
    const [saving, setSaving] = createSignal(false);
    const [syncingQueue, setSyncingQueue] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    const [loaded, setLoaded] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [searchFilter, setSearchFilter] = createSignal("");
    const [tagFilter, setTagFilter] = createSignal("");

    const applyState = (state: PromptStackerState) => {
      setPrompts(state.prompts);
      setQueueIds(state.queue);
      setLoaded(true);
    };

    const loadPrompts = async (force = false) => {
      if (loading()) return;
      if (loaded() && !force) return;

      setLoading(true);
      setError(null);
      try {
        const state = await client.getState();
        applyState(state);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    };

    const persistQueue = async (nextQueue: string[]) => {
      if (syncingQueue()) return;

      setSyncingQueue(true);
      setError(null);
      try {
        const state = await client.setQueue(nextQueue);
        applyState(state);
      } catch (err) {
        setError(String(err));
      } finally {
        setSyncingQueue(false);
      }
    };

    const saveDraft = async () => {
      const text = draft().trim();
      if (!text || saving()) return false;

      setSaving(true);
      setError(null);
      try {
        const saved = await client.savePrompt(text);
        if (loaded()) {
          setPrompts((current) => [saved, ...current]);
          setLoaded(true);
        } else {
          try {
            const state = await client.getState();
            applyState(state);
          } catch {
            setPrompts((current) => [saved, ...current]);
            setLoaded(true);
          }
        }
        setDraft("");
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
      queueIds,
      queuedPrompts: () => {
        const promptMap = new Map(prompts().map((prompt) => [prompt.id, prompt] as const));
        return queueIds()
          .map((id) => promptMap.get(id))
          .filter((prompt): prompt is PromptRecord => Boolean(prompt));
      },
      saving,
      syncingQueue,
      loading,
      loaded,
      error,
      setDraft,
      ensureLoaded: () => loadPrompts(false),
      reload: () => loadPrompts(true),
      saveDraft,
      isQueued: (promptId: string) => queueIds().includes(promptId),
      queuePosition: (promptId: string) => queueIds().indexOf(promptId),
      toggleQueued: async (promptId: string) => {
        const currentQueue = queueIds();
        const nextQueue = currentQueue.includes(promptId)
          ? currentQueue.filter((id) => id !== promptId)
          : [...currentQueue, promptId];
        await persistQueue(nextQueue);
      },
      removeFromQueue: async (promptId: string) => {
        const nextQueue = queueIds().filter((id) => id !== promptId);
        await persistQueue(nextQueue);
      },
      clearQueue: async () => {
        await persistQueue([]);
      },
      moveInQueue: async (promptId: string, delta: number) => {
        const current = queueIds();
        const idx = current.indexOf(promptId);
        if (idx < 0) return;
        const target = idx + delta;
        if (target < 0 || target >= current.length) return;
        const next = [...current];
        next[idx] = current[target];
        next[target] = promptId;
        await persistQueue(next);
      },
      advanceQueue: async () => {
        const ids = queueIds();
        if (ids.length === 0) return null;
        const promptMap = new Map(prompts().map((p) => [p.id, p] as const));
        const first = promptMap.get(ids[0]);
        if (!first) return null;
        await persistQueue(ids.slice(1));
        return first.text;
      },
      editPrompt: async (promptId: string, text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return false;
        try {
          const updated = await client.editPrompt(promptId, trimmed);
          setPrompts((current) => current.map((p) => (p.id === updated.id ? updated : p)));
          return true;
        } catch (err) {
          setError(String(err));
          return false;
        }
      },
      deletePrompt: async (promptId: string) => {
        try {
          const state = await client.deletePrompt(promptId);
          applyState(state);
        } catch (err) {
          setError(String(err));
        }
      },
      duplicatePrompt: async (promptId: string) => {
        try {
          const dup = await client.duplicatePrompt(promptId);
          // Insert right after the source prompt in the local list.
          setPrompts((current) => {
            const idx = current.findIndex((p) => p.id === promptId);
            const next = [...current];
            next.splice(idx + 1, 0, dup);
            return next;
          });
        } catch (err) {
          setError(String(err));
        }
      },
      searchFilter,
      setSearchFilter,
      filteredPrompts: () => {
        let result = prompts();
        const tag = tagFilter();
        if (tag) {
          result = result.filter((p) => p.tags?.includes(tag));
        }
        const q = searchFilter().toLowerCase().trim();
        if (q) {
          result = result.filter((p) => p.text.toLowerCase().includes(q));
        }
        return result;
      },
      setTags: async (promptId: string, tags: string[]) => {
        try {
          const updated = await client.setTags(promptId, tags);
          setPrompts((current) => current.map((p) => (p.id === updated.id ? updated : p)));
          return true;
        } catch (err) {
          setError(String(err));
          return false;
        }
      },
      tagFilter,
      setTagFilter,
      allTags: () => {
        const tags = new Set<string>();
        for (const p of prompts()) {
          if (p.tags) for (const t of p.tags) tags.add(t);
        }
        return [...tags].sort();
      },
      exportPrompts: async () => {
        try {
          return await client.exportPrompts();
        } catch (err) {
          setError(String(err));
          return null;
        }
      },
      importPrompts: async (json: string) => {
        try {
          const state = await client.importPrompts(json);
          applyState(state);
          return true;
        } catch (err) {
          setError(String(err));
          return false;
        }
      },
    };
  });
}

const promptStackerStore = createPromptStackerStore();

export function usePromptStackerStore() {
  return promptStackerStore;
}
