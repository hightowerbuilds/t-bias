// Pane tree — pure data model and tree operations.
// A pane is either a terminal leaf or a binary split node. Operations return
// new records (immutable); callers commit them to their store.
//
// Ported from the original app. Editor/file-explorer/canvas leaf types will be
// re-added in Phase 4; Phase 2 is terminal + split.

export interface TerminalPane {
  type: "terminal";
  id: number;
  cwd?: string;
  flipped?: boolean;
}

export interface ExplorerPane {
  type: "explorer";
  id: number;
  /** Directory the explorer is browsing. */
  cwd?: string;
}

export interface SplitPane {
  type: "split";
  id: number;
  /** "h" = side-by-side, "v" = stacked. */
  dir: "h" | "v";
  /** Fraction of space given to child `a`. Clamped to [0.1, 0.9]. */
  ratio: number;
  a: number;
  b: number;
}

export type LeafPane = TerminalPane | ExplorerPane;
export type Pane = LeafPane | SplitPane;
export type PaneMap = Record<number, Pane>;

/** All terminal pane IDs in layout order (DFS, a before b). */
export function terminalIds(panes: PaneMap, rootId: number): number[] {
  const out: number[] = [];
  const visit = (id: number) => {
    const p = panes[id];
    if (!p) return;
    if (p.type === "terminal") out.push(id);
    else if (p.type === "split") {
      visit(p.a);
      visit(p.b);
    }
  };
  visit(rootId);
  return out;
}

/** All explorer pane IDs in layout order. */
export function explorerIds(panes: PaneMap, rootId: number): number[] {
  const out: number[] = [];
  const visit = (id: number) => {
    const p = panes[id];
    if (!p) return;
    if (p.type === "explorer") out.push(id);
    else if (p.type === "split") {
      visit(p.a);
      visit(p.b);
    }
  };
  visit(rootId);
  return out;
}

/** All leaf pane IDs (non-split) in layout order. */
export function leafIds(panes: PaneMap, rootId: number): number[] {
  const out: number[] = [];
  const visit = (id: number) => {
    const p = panes[id];
    if (!p) return;
    if (p.type === "split") {
      visit(p.a);
      visit(p.b);
    } else {
      out.push(id);
    }
  };
  visit(rootId);
  return out;
}

function findParent(panes: PaneMap, rootId: number, targetId: number): SplitPane | null {
  const visit = (id: number): SplitPane | null => {
    const p = panes[id];
    if (!p || p.type !== "split") return null;
    if (p.a === targetId || p.b === targetId) return p;
    return visit(p.a) ?? visit(p.b);
  };
  return visit(rootId);
}

/** Split leaf `targetId` along `dir`, inserting `splitId` with a new
 *  leaf of the same type as `targetId` as the second child. */
export function splitPane(
  panes: PaneMap,
  rootId: number,
  targetId: number,
  dir: "h" | "v",
  splitId: number,
  newLeafId: number,
): { panes: PaneMap; rootId: number } {
  const target = panes[targetId];
  if (!target || target.type === "split") {
    throw new Error(`splitPane target ${targetId} is not a leaf`);
  }
  const newSplit: SplitPane = { type: "split", id: splitId, dir, ratio: 0.5, a: targetId, b: newLeafId };
  const newLeaf: LeafPane = target.type === "explorer"
    ? { type: "explorer", id: newLeafId, cwd: target.cwd }
    : { type: "terminal", id: newLeafId, cwd: target.cwd };
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
  return { panes: next, rootId: splitId };
}

/** Remove leaf `targetId`, collapsing its parent split. Returns the pane
 *  that inherits the slot as `focusId`. If target is the root, it's a no-op. */
export function closePane(
  panes: PaneMap,
  rootId: number,
  targetId: number,
): { panes: PaneMap; rootId: number; focusId: number; removed: boolean } {
  const parent = findParent(panes, rootId, targetId);
  if (!parent) return { panes, rootId, focusId: targetId, removed: false };

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
    return { panes: next, rootId, focusId: firstLeaf(next, siblingId), removed: true };
  }
  return { panes: next, rootId: siblingId, focusId: firstLeaf(next, siblingId), removed: true };
}

/** First leaf reached from `id` (id itself if it's a leaf). */
function firstLeaf(panes: PaneMap, id: number): number {
  const p = panes[id];
  if (!p || p.type !== "split") return id;
  return firstLeaf(panes, p.a);
}

/** Pane adjacent to `activeId` in layout reading order. */
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
