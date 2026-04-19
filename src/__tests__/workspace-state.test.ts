import { describe, expect, it } from "vitest";
import {
  closeActivePaneInWorkspace,
  closeTabInWorkspace,
  makeFileExplorerTab,
  makeShellTab,
  splitActivePaneInWorkspace,
  type WorkspaceState,
} from "../workspace-state";

function makeIdGenerator(start = 1) {
  let next = start;
  return () => next++;
}

describe("workspace-state", () => {
  it("replaces the last closed tab with a fresh shell tab at the same path", () => {
    const newId = makeIdGenerator();
    const original = makeShellTab(newId, "/Users/test/project");
    const result = closeTabInWorkspace(
      { tabs: [original], activeTabId: original.id },
      original.id,
      (cwd) => makeShellTab(newId, cwd),
      "/Users/test/project",
    );

    expect(result.closeTerminalPaneIds).toEqual([original.activePaneId]);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].id).not.toBe(original.id);
    expect(result.activeTabId).toBe(result.tabs[0].id);
    expect(result.tabs[0].panes[result.tabs[0].activePaneId]).toMatchObject({
      type: "terminal",
      cwd: "/Users/test/project",
    });
    expect(result.tabs[0].paneCwds[result.tabs[0].activePaneId]).toBe("/Users/test/project");
  });

  it("closes the active tab and focuses the next available tab", () => {
    const newId = makeIdGenerator();
    const first = makeShellTab(newId, "/Users/test/one");
    const second = makeFileExplorerTab(newId, "/Users/test/two");

    const result = closeTabInWorkspace(
      { tabs: [first, second], activeTabId: first.id },
      first.id,
      (cwd) => makeShellTab(newId, cwd),
    );

    expect(result.closeTerminalPaneIds).toEqual([first.activePaneId]);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].id).toBe(second.id);
    expect(result.activeTabId).toBe(second.id);
  });

  it("splits the active pane and then closes the active terminal pane cleanly", () => {
    const newId = makeIdGenerator();
    const initial = makeShellTab(newId, "/Users/test/project");
    const splitState = splitActivePaneInWorkspace(
      { tabs: [initial], activeTabId: initial.id },
      "h",
      newId,
    );
    const splitTab = splitState.tabs[0];
    const closedPaneId = splitTab.activePaneId;

    const result = closeActivePaneInWorkspace(
      splitState,
      (cwd) => makeShellTab(newId, cwd),
    );

    const nextTab = result.tabs[0];
    const leafPaneIds = Object.values(nextTab.panes)
      .filter((pane) => pane.type !== "split")
      .map((pane) => pane.id);

    expect(result.closeTerminalPaneIds).toEqual([closedPaneId]);
    expect(leafPaneIds).toHaveLength(1);
    expect(nextTab.activePaneId).toBe(leafPaneIds[0]);
    expect(nextTab.panes[nextTab.activePaneId]).toMatchObject({
      type: "terminal",
      cwd: "/Users/test/project",
    });
    expect(nextTab.paneCwds[closedPaneId]).toBeUndefined();
  });

  it("treats single-pane close as tab close and replaces explorer with a shell tab", () => {
    const newId = makeIdGenerator();
    const explorer = makeFileExplorerTab(newId, "/Users/test/project/docs");
    const state: WorkspaceState = {
      tabs: [explorer],
      activeTabId: explorer.id,
    };

    const result = closeActivePaneInWorkspace(
      state,
      (cwd) => makeShellTab(newId, cwd),
      "/Users/test/project/docs",
    );

    expect(result.closeTerminalPaneIds).toEqual([]);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].panes[result.tabs[0].activePaneId]).toMatchObject({
      type: "terminal",
      cwd: "/Users/test/project/docs",
    });
  });
});
