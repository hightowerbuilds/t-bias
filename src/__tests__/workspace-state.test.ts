import { describe, expect, it } from "vitest";
import {
  activatePaneInWorkspace,
  closeActivePaneInWorkspace,
  closeTabInWorkspace,
  makeEditorTab,
  makeFileExplorerTab,
  makeShellTab,
  navigatePaneInWorkspace,
  splitActivePaneInWorkspace,
  toggleFlipPaneInWorkspace,
  updateSplitRatioInWorkspace,
  type WorkspaceState,
} from "../workspace-state";
import type { SplitPane, TerminalPane } from "../pane-tree";

function makeIdGenerator(start = 1) {
  let next = start;
  return () => next++;
}

// ---------------------------------------------------------------------------
// Tab creation, switching, and close
// ---------------------------------------------------------------------------

describe("tab creation and switching", () => {
  it("creates a shell tab with cwd and correct structure", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home/user");

    expect(tab.title).toBe("Shell");
    expect(tab.hasActivity).toBe(false);
    expect(tab.zoomed).toBe(false);
    const pane = tab.panes[tab.activePaneId];
    expect(pane).toMatchObject({ type: "terminal", cwd: "/home/user" });
    expect(tab.paneCwds[tab.activePaneId]).toBe("/home/user");
  });

  it("creates a shell tab with shellId and title", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, { cwd: "/tmp", shellId: "s123", title: "My Shell" });

    expect(tab.title).toBe("My Shell");
    const pane = tab.panes[tab.activePaneId] as TerminalPane;
    expect(pane.shellId).toBe("s123");
    expect(pane.cwd).toBe("/tmp");
  });

  it("creates a file explorer tab", () => {
    const newId = makeIdGenerator();
    const tab = makeFileExplorerTab(newId, "/Users/test/docs");

    expect(tab.title).toBe("Files");
    expect(tab.panes[tab.activePaneId]).toMatchObject({ type: "file-explorer" });
    expect(tab.paneCwds[tab.activePaneId]).toBe("/Users/test/docs");
  });

  it("creates an editor tab with filePath", () => {
    const newId = makeIdGenerator();
    const tab = makeEditorTab(newId, "/Users/test/README.md");

    expect(tab.title).toBe("README.md");
    expect(tab.panes[tab.activePaneId]).toMatchObject({
      type: "editor",
      filePath: "/Users/test/README.md",
    });
  });

  it("activatePaneInWorkspace switches the active pane", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    const state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };

    // Split to get a second pane
    const split = splitActivePaneInWorkspace(state, "h", newId);
    const splitTab = split.tabs[0];
    const allLeaves = Object.values(splitTab.panes).filter(p => p.type !== "split");
    const otherPane = allLeaves.find(p => p.id !== splitTab.activePaneId)!;

    const result = activatePaneInWorkspace(split, otherPane.id);
    expect(result.tabs[0].activePaneId).toBe(otherPane.id);
  });
});

describe("tab close behavior", () => {
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

  it("closing a non-active tab preserves the active tab", () => {
    const newId = makeIdGenerator();
    const first = makeShellTab(newId, "/one");
    const second = makeShellTab(newId, "/two");
    const third = makeShellTab(newId, "/three");

    const result = closeTabInWorkspace(
      { tabs: [first, second, third], activeTabId: second.id },
      third.id,
      (cwd) => makeShellTab(newId, cwd),
    );

    expect(result.tabs).toHaveLength(2);
    expect(result.activeTabId).toBe(second.id);
  });

  it("closing the last tab in a 3-tab set focuses the previous tab", () => {
    const newId = makeIdGenerator();
    const a = makeShellTab(newId);
    const b = makeShellTab(newId);
    const c = makeShellTab(newId);

    const result = closeTabInWorkspace(
      { tabs: [a, b, c], activeTabId: c.id },
      c.id,
      (cwd) => makeShellTab(newId, cwd),
    );

    expect(result.tabs).toHaveLength(2);
    expect(result.activeTabId).toBe(b.id);
  });

  it("treats single-pane close as tab close and replaces explorer with a shell tab", () => {
    const newId = makeIdGenerator();
    const explorer = makeFileExplorerTab(newId, "/Users/test/project/docs");
    const state: WorkspaceState = { tabs: [explorer], activeTabId: explorer.id };

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

  it("closing a tab with splits returns all terminal pane IDs", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };
    state = splitActivePaneInWorkspace(state, "h", newId);
    const splitTab = state.tabs[0];

    const terminalIds = Object.values(splitTab.panes)
      .filter(p => p.type === "terminal")
      .map(p => p.id);

    const result = closeTabInWorkspace(
      state,
      splitTab.id,
      (cwd) => makeShellTab(newId, cwd),
    );

    expect(result.closeTerminalPaneIds.sort()).toEqual(terminalIds.sort());
  });
});

// ---------------------------------------------------------------------------
// Pane splitting and collapse
// ---------------------------------------------------------------------------

describe("pane splitting", () => {
  it("splits the active pane horizontally", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    const state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };

    const result = splitActivePaneInWorkspace(state, "h", newId);
    const splitTab = result.tabs[0];

    // Root should now be a split
    const root = splitTab.panes[splitTab.rootId];
    expect(root.type).toBe("split");
    expect((root as SplitPane).dir).toBe("h");

    // Active pane should be the new leaf (not the original)
    expect(splitTab.activePaneId).not.toBe(tab.activePaneId);
    expect(splitTab.panes[splitTab.activePaneId]).toMatchObject({ type: "terminal" });

    // Original pane should still be in the tree
    expect(splitTab.panes[tab.activePaneId]).toBeTruthy();
  });

  it("splits the active pane vertically", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    const state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };

    const result = splitActivePaneInWorkspace(state, "v", newId);
    const root = result.tabs[0].panes[result.tabs[0].rootId];
    expect((root as SplitPane).dir).toBe("v");
  });

  it("does not split when zoomed", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    tab.zoomed = true;
    const state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };

    const result = splitActivePaneInWorkspace(state, "h", newId);
    // Should be unchanged
    expect(result.tabs[0].rootId).toBe(tab.rootId);
  });

  it("nested split creates a 3-pane layout", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };

    state = splitActivePaneInWorkspace(state, "h", newId);
    state = splitActivePaneInWorkspace(state, "v", newId);

    const splitTab = state.tabs[0];
    const terminals = Object.values(splitTab.panes).filter(p => p.type === "terminal");
    expect(terminals).toHaveLength(3);
  });
});

describe("pane close in split", () => {
  it("closes the active pane and collapses the split", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/Users/test/project");
    const splitState = splitActivePaneInWorkspace(
      { tabs: [tab], activeTabId: tab.id },
      "h",
      newId,
    );
    const closedPaneId = splitState.tabs[0].activePaneId;

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
    expect(nextTab.paneCwds[closedPaneId]).toBeUndefined();
  });

  it("close in a 3-pane layout leaves 2 panes", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };
    state = splitActivePaneInWorkspace(state, "h", newId);
    state = splitActivePaneInWorkspace(state, "v", newId);

    const result = closeActivePaneInWorkspace(state, (cwd) => makeShellTab(newId, cwd));
    const terminals = Object.values(result.tabs[0].panes).filter(p => p.type === "terminal");
    expect(terminals).toHaveLength(2);
  });

  it("closing zoomed pane just unzooms without closing", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };
    state = splitActivePaneInWorkspace(state, "h", newId);
    // Zoom in
    state.tabs[0].zoomed = true;

    const result = closeActivePaneInWorkspace(state, (cwd) => makeShellTab(newId, cwd));
    expect(result.closeTerminalPaneIds).toEqual([]);
    expect(result.tabs[0].zoomed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pane navigation and flip
// ---------------------------------------------------------------------------

describe("pane navigation", () => {
  it("navigates between split panes", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };
    state = splitActivePaneInWorkspace(state, "h", newId);

    const splitTab = state.tabs[0];
    const activeBefore = splitTab.activePaneId;

    // Navigate left should change active pane
    const result = navigatePaneInWorkspace(state, "left");
    expect(result.tabs[0].activePaneId).not.toBe(activeBefore);
  });

  it("navigation does nothing when zoomed", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };
    state = splitActivePaneInWorkspace(state, "h", newId);
    state.tabs[0].zoomed = true;

    const activeBefore = state.tabs[0].activePaneId;
    const result = navigatePaneInWorkspace(state, "left");
    expect(result.tabs[0].activePaneId).toBe(activeBefore);
  });
});

describe("pane flip", () => {
  it("toggles flipped state on a terminal pane", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    const state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };

    const result = toggleFlipPaneInWorkspace(state, tab.activePaneId);
    const pane = result.tabs[0].panes[tab.activePaneId] as TerminalPane;
    expect(pane.flipped).toBe(true);

    const result2 = toggleFlipPaneInWorkspace(result, tab.activePaneId);
    const pane2 = result2.tabs[0].panes[tab.activePaneId] as TerminalPane;
    expect(pane2.flipped).toBe(false);
  });
});

describe("split ratio", () => {
  it("updates the split ratio", () => {
    const newId = makeIdGenerator();
    const tab = makeShellTab(newId, "/home");
    let state: WorkspaceState = { tabs: [tab], activeTabId: tab.id };
    state = splitActivePaneInWorkspace(state, "h", newId);

    const splitId = state.tabs[0].rootId;
    const result = updateSplitRatioInWorkspace(state, splitId, 0.7);
    expect((result.tabs[0].panes[splitId] as SplitPane).ratio).toBe(0.7);
  });
});
