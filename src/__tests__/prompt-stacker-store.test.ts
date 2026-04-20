import { describe, expect, it, vi } from "vitest";
import { createPromptStackerStore, type PromptStackerClient } from "../promptStackerStore";
import type { PromptRecord, PromptStackerState } from "../ipc/types";

function makePrompt(id: string, text: string, createdAt = 1): PromptRecord {
  return { id, text, created_at: createdAt };
}

function makeClient(state: PromptStackerState): PromptStackerClient {
  let currentState = structuredClone(state);

  return {
    getState: vi.fn(async () => structuredClone(currentState)),
    savePrompt: vi.fn(async (text: string) => {
      const prompt = makePrompt(`saved-${currentState.prompts.length + 1}`, text, 99);
      currentState = {
        ...currentState,
        prompts: [prompt, ...currentState.prompts],
      };
      return prompt;
    }),
    setQueue: vi.fn(async (queue: string[]) => {
      currentState = {
        ...currentState,
        queue: [...queue],
      };
      return structuredClone(currentState);
    }),
  };
}

describe("prompt-stacker-store", () => {
  it("loads persisted prompts once and derives queued prompts in queue order", async () => {
    const client = makeClient({
      prompts: [
        makePrompt("a", "First"),
        makePrompt("b", "Second"),
        makePrompt("c", "Third"),
      ],
      queue: ["c", "missing", "a"],
    });
    const store = createPromptStackerStore(client);

    await store.ensureLoaded();
    await store.ensureLoaded();

    expect(client.getState).toHaveBeenCalledTimes(1);
    expect(store.prompts().map((prompt) => prompt.id)).toEqual(["a", "b", "c"]);
    expect(store.queueIds()).toEqual(["c", "missing", "a"]);
    expect(store.queuedPrompts().map((prompt) => prompt.id)).toEqual(["c", "a"]);
    expect(store.queuePosition("a")).toBe(2);
    expect(store.isQueued("b")).toBe(false);
  });

  it("saves a trimmed draft, clears the draft, and prepends the saved prompt", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "Existing prompt")],
      queue: [],
    });
    const store = createPromptStackerStore(client);

    store.setDraft("  New prompt text  ");
    const saved = await store.saveDraft();

    expect(saved).toBe(true);
    expect(client.savePrompt).toHaveBeenCalledWith("New prompt text");
    expect(store.draft()).toBe("");
    expect(store.prompts().map((prompt) => prompt.text)).toEqual([
      "New prompt text",
      "Existing prompt",
    ]);
  });

  it("toggles queued prompts and persists the next queue state", async () => {
    const client = makeClient({
      prompts: [
        makePrompt("a", "First"),
        makePrompt("b", "Second"),
      ],
      queue: ["a"],
    });
    const store = createPromptStackerStore(client);

    await store.ensureLoaded();
    await store.toggleQueued("b");
    await store.toggleQueued("a");

    expect(client.setQueue).toHaveBeenNthCalledWith(1, ["a", "b"]);
    expect(client.setQueue).toHaveBeenNthCalledWith(2, ["b"]);
    expect(store.queueIds()).toEqual(["b"]);
    expect(store.queuedPrompts().map((prompt) => prompt.id)).toEqual(["b"]);
  });

  it("reloads from the backend even after initial load", async () => {
    const states: PromptStackerState[] = [
      {
        prompts: [makePrompt("a", "First")],
        queue: [],
      },
      {
        prompts: [makePrompt("b", "Second")],
        queue: ["b"],
      },
    ];
    let index = 0;
    const client: PromptStackerClient = {
      getState: vi.fn(async () => structuredClone(states[index++] ?? states.at(-1)!)),
      savePrompt: vi.fn(),
      setQueue: vi.fn(),
    };
    const store = createPromptStackerStore(client);

    await store.ensureLoaded();
    await store.reload();

    expect(client.getState).toHaveBeenCalledTimes(2);
    expect(store.prompts().map((prompt) => prompt.id)).toEqual(["b"]);
    expect(store.queueIds()).toEqual(["b"]);
  });

  it("removes a specific prompt from the queue", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "First"), makePrompt("b", "Second"), makePrompt("c", "Third")],
      queue: ["a", "b", "c"],
    });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    await store.removeFromQueue("b");

    expect(client.setQueue).toHaveBeenCalledWith(["a", "c"]);
    expect(store.queueIds()).toEqual(["a", "c"]);
  });

  it("clears the entire queue", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "First"), makePrompt("b", "Second")],
      queue: ["a", "b"],
    });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    await store.clearQueue();

    expect(client.setQueue).toHaveBeenCalledWith([]);
    expect(store.queueIds()).toEqual([]);
    expect(store.queuedPrompts()).toEqual([]);
  });

  it("moves a prompt left in the queue", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "First"), makePrompt("b", "Second"), makePrompt("c", "Third")],
      queue: ["a", "b", "c"],
    });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    await store.moveInQueue("c", -1);

    expect(client.setQueue).toHaveBeenCalledWith(["a", "c", "b"]);
  });

  it("moves a prompt right in the queue", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "First"), makePrompt("b", "Second"), makePrompt("c", "Third")],
      queue: ["a", "b", "c"],
    });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    await store.moveInQueue("a", 1);

    expect(client.setQueue).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("advances the queue: returns first item text and removes it", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "First"), makePrompt("b", "Second"), makePrompt("c", "Third")],
      queue: ["a", "b", "c"],
    });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    const text = await store.advanceQueue();

    expect(text).toBe("First");
    expect(client.setQueue).toHaveBeenCalledWith(["b", "c"]);
    expect(store.queueIds()).toEqual(["b", "c"]);
  });

  it("advanceQueue returns null on empty queue", async () => {
    const client = makeClient({ prompts: [], queue: [] });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    const text = await store.advanceQueue();

    expect(text).toBeNull();
    expect(client.setQueue).not.toHaveBeenCalled();
  });

  it("does not move past queue boundaries", async () => {
    const client = makeClient({
      prompts: [makePrompt("a", "First"), makePrompt("b", "Second")],
      queue: ["a", "b"],
    });
    const store = createPromptStackerStore(client);
    await store.ensureLoaded();

    await store.moveInQueue("a", -1); // Already at start
    await store.moveInQueue("b", 1);  // Already at end

    expect(client.setQueue).not.toHaveBeenCalled();
  });
});
