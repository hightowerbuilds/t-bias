import { describe, expect, it } from "vitest";
import type { SavedTab } from "../ipc/types";
import {
  savedTabToTabState,
  tabToSavedTab,
  type SessionTabState,
} from "../session-state";

function makeIdGenerator(start = 1000) {
  let next = start;
  return () => next++;
}

describe("session-state", () => {
  it("persists terminal cwd across save and restore", () => {
    const tab: SessionTabState = {
      id: 10,
      title: "Shell",
      hasActivity: false,
      rootId: 1,
      activePaneId: 1,
      panes: { 1: { type: "terminal", id: 1, cwd: "/Users/test/project" } },
      paneTitles: { 1: "Shell" },
      paneProcessTitles: {},
      paneCwds: { 1: "/Users/test/project" },
      zoomed: false,
    };

    const saved = tabToSavedTab(tab);
    expect(saved).toEqual({
      layout: { type: "terminal", cwd: "/Users/test/project" },
      activePaneIndex: 0,
      title: "Shell",
    });

    const restored = savedTabToTabState(saved, makeIdGenerator());
    expect(restored.panes[restored.activePaneId]).toMatchObject({
      type: "terminal",
      cwd: "/Users/test/project",
    });
    expect(restored.paneCwds[restored.activePaneId]).toBe("/Users/test/project");
  });

  it("restores split tabs with terminal cwd and file explorer root", () => {
    const tab: SessionTabState = {
      id: 20,
      title: "Docs",
      hasActivity: false,
      rootId: 3,
      activePaneId: 2,
      panes: {
        1: { type: "terminal", id: 1, cwd: "/Users/test/project" },
        2: { type: "file-explorer", id: 2 },
        3: { type: "split", id: 3, dir: "h", ratio: 0.4, a: 1, b: 2 },
      },
      paneTitles: { 1: "Shell", 2: "Files" },
      paneProcessTitles: {},
      paneCwds: {
        1: "/Users/test/project",
        2: "/Users/test/project/docs",
      },
      zoomed: false,
    };

    const saved = tabToSavedTab(tab);
    expect(saved.layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.4,
      a: { type: "terminal", cwd: "/Users/test/project" },
      b: { type: "file-explorer", path: "/Users/test/project/docs" },
    });
    expect(saved.activePaneIndex).toBe(1);

    const restored = savedTabToTabState(saved, makeIdGenerator());
    const restoredLeaves = Object.values(restored.panes).filter((pane) => pane.type !== "split");
    const restoredTerminal = restoredLeaves.find((pane) => pane.type === "terminal");
    const restoredExplorer = restoredLeaves.find((pane) => pane.type === "file-explorer");

    expect(restoredTerminal).toBeTruthy();
    expect(restoredExplorer).toBeTruthy();
    expect(restored.panes[restored.activePaneId]?.type).toBe("file-explorer");
    expect(restored.paneCwds[restoredTerminal!.id]).toBe("/Users/test/project");
    expect(restored.paneCwds[restoredExplorer!.id]).toBe("/Users/test/project/docs");
  });

  it("maps legacy prompt stacker tabs back to a shell pane on restore", () => {
    const saved: SavedTab = {
      layout: { type: "prompt-stacker" },
      activePaneIndex: 0,
      title: "Prompt Stacker",
    };

    const restored = savedTabToTabState(saved, makeIdGenerator());
    expect(restored.title).toBe("Shell");
    expect(restored.panes[restored.activePaneId]).toMatchObject({
      type: "terminal",
    });
  });
});
