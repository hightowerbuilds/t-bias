// ---------------------------------------------------------------------------
// Pane tree — pure data model and tree operations
// ---------------------------------------------------------------------------
// A pane is either a terminal leaf or a binary split node.
// Operations return new records (immutable); callers update their stores.

export interface TerminalPane {
  type: "terminal";
  id: number;
  flipped?: boolean;
  cwd?: string;
  shellId?: string;
}

export interface FileExplorerPane {
  type: "file-explorer";
  id: number;
}

export interface PromptStackerPane {
  type: "prompt-stacker";
  id: number;
}

export interface EditorPane {
  type: "editor";
  id: number;
  filePath?: string;
}

export interface SplitPane {
  type: "split";
  id: number;
  /** "h" = horizontal (side-by-side), "v" = vertical (stacked) */
  dir: "h" | "v";
  /** Fraction of space given to pane `a`. Clamped to [0.1, 0.9]. */
  ratio: number;
  a: number; // first child pane ID
  b: number; // second child pane ID
}

export type Pane = TerminalPane | FileExplorerPane | PromptStackerPane | EditorPane | SplitPane;
export type PaneMap = Record<number, Pane>;

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

/** All terminal pane IDs in layout order (DFS, a before b). */
export function terminalIds(panes: PaneMap, rootId: number): number[] {
  const result: number[] = [];
  const visit = (id: number) => {
    const p = panes[id];
    if (!p) return;
    if (p.type === "terminal") { result.push(id); return; }
    if (p.type === "split") { visit(p.a); visit(p.b); }
  };
  visit(rootId);
  return result;
}

/** All leaf pane IDs (any non-split type) in layout order. */
export function leafIds(panes: PaneMap, rootId: number): number[] {
  const result: number[] = [];
  const visit = (id: number) => {
    const p = panes[id];
    if (!p) return;
    if (p.type === "split") { visit(p.a); visit(p.b); return; }
    result.push(id);
  };
  visit(rootId);
  return result;
}

/** Find the direct parent SplitPane of `targetId`, or null if targetId is root. */
function findParent(panes: PaneMap, rootId: number, targetId: number): SplitPane | null {
  const visit = (id: number): SplitPane | null => {
    const p = panes[id];
    if (!p || p.type !== "split") return null;
    if (p.a === targetId || p.b === targetId) return p;
    return visit(p.a) ?? visit(p.b);
  };
  return visit(rootId);
}

// ---------------------------------------------------------------------------
// Mutating operations (return new PaneMap + rootId)
// ---------------------------------------------------------------------------

/** Split the terminal pane `targetId` along `dir`.
 *  Inserts a new SplitPane (`splitId`) with targetId as `a` and `newLeafId` as `b`.
 *  Returns the updated pane map and root ID. */
export function splitPane(
  panes: PaneMap,
  rootId: number,
  targetId: number,
  dir: "h" | "v",
  splitId: number,
  newLeafId: number,
): { panes: PaneMap; rootId: number } {
  const newSplit: SplitPane = {
    type: "split",
    id: splitId,
    dir,
    ratio: 0.5,
    a: targetId,
    b: newLeafId,
  };
  const newLeaf: TerminalPane = { type: "terminal", id: newLeafId };

  const next: PaneMap = { ...panes, [splitId]: newSplit, [newLeafId]: newLeaf };

  const parent = findParent(panes, rootId, targetId);
  if (parent) {
    next[parent.id] = {
      ...parent,
      a: parent.a === targetId ? splitId : parent.a,
      b: parent.b === targetId ? splitId : parent.b,
    };
    return { panes: next, rootId };
  }
  // targetId was root → split becomes new root
  return { panes: next, rootId: splitId };
}

/** Remove terminal pane `targetId`, collapsing its parent split.
 *  Returns the updated pane map, the new root ID, and the pane that inherited
 *  the slot (for auto-focus). */
export function closePane(
  panes: PaneMap,
  rootId: number,
  targetId: number,
): { panes: PaneMap; rootId: number; focusId: number } {
  const parent = findParent(panes, rootId, targetId);
  if (!parent) return { panes, rootId, focusId: targetId }; // already root, can't close

  const siblingId = parent.a === targetId ? parent.b : parent.a;
  const next: PaneMap = { ...panes };
  delete next[targetId];
  delete next[parent.id];

  const grandparent = findParent(panes, rootId, parent.id);
  if (grandparent) {
    next[grandparent.id] = {
      ...grandparent,
      a: grandparent.a === parent.id ? siblingId : grandparent.a,
      b: grandparent.b === parent.id ? siblingId : grandparent.b,
    };
    return { panes: next, rootId, focusId: siblingId };
  }
  // Parent was root → sibling becomes new root
  return { panes: next, rootId: siblingId, focusId: siblingId };
}

/** Return the pane adjacent to `activeId` in the given direction,
 *  using layout reading order (DFS left-to-right, top-to-bottom). */
export function findAdjacent(
  panes: PaneMap,
  rootId: number,
  activeId: number,
  dir: "left" | "right" | "up" | "down",
): number | null {
  const ids = leafIds(panes, rootId);
  const idx = ids.indexOf(activeId);
  if (idx === -1) return null;
  const step = dir === "right" || dir === "down" ? 1 : -1;
  const next = idx + step;
  return next >= 0 && next < ids.length ? ids[next] : null;
}

/** Toggle the flip state of a terminal pane. */
export function toggleFlip(panes: PaneMap, targetId: number): PaneMap {
  const pane = panes[targetId];
  if (!pane || pane.type !== "terminal") return panes;
  return {
    ...panes,
    [targetId]: { ...pane, flipped: !pane.flipped },
  };
}
