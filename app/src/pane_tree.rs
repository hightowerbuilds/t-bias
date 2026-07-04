// t-bias — pane tree (Phase 4).
//
// Pure data model + tree ops for a tab's pane layout. A pane is a leaf
// (terminal or explorer) or a binary split node. Ported from the Deno app's
// `src/pane-tree.ts`; the tree owns id allocation here (the TS version took ids
// from the caller) but the operations mirror it exactly — see the unit tests.
//
// Rendering, sessions, and drag-resize wire on top of this in later Phase 4
// slices; this module is deliberately UI-free so it can be tested headlessly.
//
// The public API is exercised by unit tests but not yet by the UI (that lands
// with the tab/split rendering, which is blocked on the text-rendering fix), so
// allow dead code module-wide until then.
#![allow(dead_code)]

use std::collections::HashMap;

pub type PaneId = u64;

/// Split orientation. `Horizontal` = side-by-side (TS "h"); `Vertical` =
/// stacked (TS "v").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitDir {
    Horizontal,
    Vertical,
}

/// Navigation direction for `adjacent` (linear layout order, like the TS app).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nav {
    Left,
    Right,
    Up,
    Down,
}

/// A node in the pane tree. Leaves carry their own state; splits reference
/// child ids. A pane's id is its key in the `PaneTree` map, not stored here.
#[derive(Clone, Debug, PartialEq)]
pub enum Pane {
    Terminal {
        cwd: Option<String>,
        flipped: bool,
    },
    Explorer {
        cwd: Option<String>,
    },
    Split {
        dir: SplitDir,
        /// Fraction of space given to child `a`, clamped to [0.1, 0.9].
        ratio: f32,
        a: PaneId,
        b: PaneId,
    },
}

impl Pane {
    pub fn is_leaf(&self) -> bool {
        !matches!(self, Pane::Split { .. })
    }

    fn cwd(&self) -> Option<String> {
        match self {
            Pane::Terminal { cwd, .. } | Pane::Explorer { cwd } => cwd.clone(),
            Pane::Split { .. } => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PaneError {
    NotFound(PaneId),
    NotALeaf(PaneId),
}

/// The ratio bounds a split may take, matching the TS clamp.
const RATIO_MIN: f32 = 0.1;
const RATIO_MAX: f32 = 0.9;

/// A tab's pane layout: the pane map, the root id, and an id allocator.
#[derive(Clone, Debug, PartialEq)]
pub struct PaneTree {
    panes: HashMap<PaneId, Pane>,
    root: PaneId,
    next_id: PaneId,
}

impl PaneTree {
    /// A fresh tree with a single terminal leaf as the root.
    pub fn new() -> Self {
        let mut panes = HashMap::new();
        let root = 1;
        panes.insert(
            root,
            Pane::Terminal {
                cwd: None,
                flipped: false,
            },
        );
        Self {
            panes,
            root,
            next_id: root + 1,
        }
    }

    /// Reconstruct a tree from persisted parts (used by the DB layer). `next_id`
    /// is the allocator high-water mark so restored ids never collide.
    pub fn from_parts(panes: HashMap<PaneId, Pane>, root: PaneId, next_id: PaneId) -> Self {
        Self {
            panes,
            root,
            next_id,
        }
    }

    pub fn root(&self) -> PaneId {
        self.root
    }

    /// The next id the allocator will hand out (persisted so restores continue
    /// the sequence).
    pub fn next_id(&self) -> PaneId {
        self.next_id
    }

    /// All (id, pane) entries — order is unspecified (HashMap). Used for
    /// serialization; the tree shape is recovered from split `a`/`b` pointers.
    pub fn entries(&self) -> impl Iterator<Item = (PaneId, &Pane)> {
        self.panes.iter().map(|(id, pane)| (*id, pane))
    }

    pub fn get(&self, id: PaneId) -> Option<&Pane> {
        self.panes.get(&id)
    }

    pub fn len(&self) -> usize {
        self.panes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.panes.is_empty()
    }

    fn alloc(&mut self) -> PaneId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Leaf ids in layout order (DFS, `a` before `b`).
    pub fn leaf_ids(&self) -> Vec<PaneId> {
        let mut out = Vec::new();
        self.collect_leaves(self.root, &mut out, |_| true);
        out
    }

    /// Terminal-leaf ids in layout order.
    pub fn terminal_ids(&self) -> Vec<PaneId> {
        let mut out = Vec::new();
        self.collect_leaves(self.root, &mut out, |p| matches!(p, Pane::Terminal { .. }));
        out
    }

    /// Explorer-leaf ids in layout order.
    pub fn explorer_ids(&self) -> Vec<PaneId> {
        let mut out = Vec::new();
        self.collect_leaves(self.root, &mut out, |p| matches!(p, Pane::Explorer { .. }));
        out
    }

    fn collect_leaves(&self, id: PaneId, out: &mut Vec<PaneId>, keep: impl Fn(&Pane) -> bool + Copy) {
        let Some(pane) = self.panes.get(&id) else {
            return;
        };
        match pane {
            Pane::Split { a, b, .. } => {
                self.collect_leaves(*a, out, keep);
                self.collect_leaves(*b, out, keep);
            }
            leaf => {
                if keep(leaf) {
                    out.push(id);
                }
            }
        }
    }

    /// The split whose child is `target`, or None if `target` is the root.
    fn find_parent(&self, target: PaneId) -> Option<PaneId> {
        self.find_parent_from(self.root, target)
    }

    fn find_parent_from(&self, id: PaneId, target: PaneId) -> Option<PaneId> {
        let Some(Pane::Split { a, b, .. }) = self.panes.get(&id) else {
            return None;
        };
        if *a == target || *b == target {
            return Some(id);
        }
        self.find_parent_from(*a, target)
            .or_else(|| self.find_parent_from(*b, target))
    }

    /// First leaf reached from `id` (id itself if it is a leaf).
    fn first_leaf(&self, id: PaneId) -> PaneId {
        match self.panes.get(&id) {
            Some(Pane::Split { a, .. }) => self.first_leaf(*a),
            _ => id,
        }
    }

    /// Split leaf `target` along `dir`, inserting a new split whose second child
    /// is a fresh leaf of the same type as `target`. Returns the new leaf's id.
    pub fn split(&mut self, target: PaneId, dir: SplitDir) -> Result<PaneId, PaneError> {
        let target_pane = self.panes.get(&target).ok_or(PaneError::NotFound(target))?;
        if !target_pane.is_leaf() {
            return Err(PaneError::NotALeaf(target));
        }
        let new_leaf = match target_pane {
            Pane::Explorer { cwd } => Pane::Explorer { cwd: cwd.clone() },
            _ => Pane::Terminal {
                cwd: target_pane.cwd(),
                flipped: false,
            },
        };

        let new_leaf_id = self.alloc();
        let split_id = self.alloc();
        self.panes.insert(new_leaf_id, new_leaf);
        self.panes.insert(
            split_id,
            Pane::Split {
                dir,
                ratio: 0.5,
                a: target,
                b: new_leaf_id,
            },
        );

        // Re-point the parent (or the root) at the new split.
        match self.find_parent(target) {
            Some(parent_id) => {
                if let Some(Pane::Split { a, b, .. }) = self.panes.get_mut(&parent_id) {
                    if *a == target {
                        *a = split_id;
                    }
                    if *b == target {
                        *b = split_id;
                    }
                }
            }
            None => self.root = split_id,
        }
        Ok(new_leaf_id)
    }

    /// Remove leaf `target`, collapsing its parent split so the sibling takes the
    /// slot. Returns the id of the leaf that should receive focus, or None if
    /// `target` is the root (nothing to remove) or not present.
    pub fn close(&mut self, target: PaneId) -> Option<PaneId> {
        let parent_id = self.find_parent(target)?;
        let (pa, pb) = match self.panes.get(&parent_id) {
            Some(Pane::Split { a, b, .. }) => (*a, *b),
            _ => return None,
        };
        let sibling = if pa == target { pb } else { pa };

        self.panes.remove(&target);
        let grandparent = self.find_parent(parent_id);
        self.panes.remove(&parent_id);

        match grandparent {
            Some(gp) => {
                if let Some(Pane::Split { a, b, .. }) = self.panes.get_mut(&gp) {
                    if *a == parent_id {
                        *a = sibling;
                    }
                    if *b == parent_id {
                        *b = sibling;
                    }
                }
            }
            None => self.root = sibling,
        }
        Some(self.first_leaf(sibling))
    }

    /// Clamp and set a split's ratio. No-op if `id` is not a split.
    pub fn set_ratio(&mut self, id: PaneId, ratio: f32) {
        if let Some(Pane::Split { ratio: r, .. }) = self.panes.get_mut(&id) {
            *r = ratio.clamp(RATIO_MIN, RATIO_MAX);
        }
    }

    /// The pane adjacent to `active` in layout order.
    pub fn adjacent(&self, active: PaneId, dir: Nav) -> Option<PaneId> {
        let ids = self.leaf_ids();
        let idx = ids.iter().position(|&id| id == active)?;
        let step: isize = match dir {
            Nav::Right | Nav::Down => 1,
            Nav::Left | Nav::Up => -1,
        };
        let next = idx as isize + step;
        if next >= 0 && (next as usize) < ids.len() {
            Some(ids[next as usize])
        } else {
            None
        }
    }
}

impl Default for PaneTree {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_tree_is_single_terminal_leaf() {
        let t = PaneTree::new();
        assert_eq!(t.leaf_ids(), vec![t.root()]);
        assert_eq!(t.terminal_ids(), vec![t.root()]);
        assert!(matches!(t.get(t.root()), Some(Pane::Terminal { .. })));
    }

    #[test]
    fn split_root_replaces_root_with_split() {
        let mut t = PaneTree::new();
        let old = t.root();
        let new_leaf = t.split(old, SplitDir::Horizontal).unwrap();

        // Root is now a split with the old leaf as `a`, new leaf as `b`.
        let root = t.root();
        assert_ne!(root, old);
        match t.get(root) {
            Some(Pane::Split { a, b, ratio, dir }) => {
                assert_eq!(*a, old);
                assert_eq!(*b, new_leaf);
                assert_eq!(*ratio, 0.5);
                assert_eq!(*dir, SplitDir::Horizontal);
            }
            other => panic!("root not a split: {other:?}"),
        }
        // Leaf order is a-before-b.
        assert_eq!(t.leaf_ids(), vec![old, new_leaf]);
    }

    #[test]
    fn split_copies_leaf_type_and_cwd() {
        let mut t = PaneTree::new();
        let root = t.root();
        // Give the root a cwd, then split — the new leaf inherits it.
        if let Some(Pane::Terminal { cwd, .. }) = t.panes.get_mut(&root) {
            *cwd = Some("/tmp".into());
        }
        let new_leaf = t.split(root, SplitDir::Vertical).unwrap();
        assert_eq!(
            t.get(new_leaf),
            Some(&Pane::Terminal {
                cwd: Some("/tmp".into()),
                flipped: false
            })
        );
    }

    #[test]
    fn split_nested_leaf_updates_parent_pointer() {
        let mut t = PaneTree::new();
        let a = t.root();
        let b = t.split(a, SplitDir::Horizontal).unwrap();
        let split = t.root();
        // Split `b` again; the root split's `b` pointer must move to the new split.
        let c = t.split(b, SplitDir::Vertical).unwrap();
        match t.get(split) {
            Some(Pane::Split { a: ra, b: rb, .. }) => {
                assert_eq!(*ra, a);
                assert_ne!(*rb, b, "root.b should now point at the new nested split");
            }
            other => panic!("expected split: {other:?}"),
        }
        // Leaf order: a, b, c (DFS).
        assert_eq!(t.leaf_ids(), vec![a, b, c]);
    }

    #[test]
    fn close_collapses_parent_and_returns_sibling_focus() {
        let mut t = PaneTree::new();
        let a = t.root();
        let b = t.split(a, SplitDir::Horizontal).unwrap();
        // Close `a` — sibling `b` takes the slot and becomes the root.
        let focus = t.close(a);
        assert_eq!(focus, Some(b));
        assert_eq!(t.root(), b);
        assert_eq!(t.leaf_ids(), vec![b]);
        assert!(t.get(a).is_none());
    }

    #[test]
    fn close_nested_rewires_grandparent() {
        let mut t = PaneTree::new();
        let a = t.root();
        let b = t.split(a, SplitDir::Horizontal).unwrap();
        let root_split = t.root();
        let c = t.split(b, SplitDir::Vertical).unwrap();
        // Now: root_split{ a, inner_split{ b, c } }. Close `b`.
        let focus = t.close(b);
        assert_eq!(focus, Some(c));
        // Grandparent (root split) `b` slot now points at `c` directly.
        match t.get(root_split) {
            Some(Pane::Split { a: ra, b: rb, .. }) => {
                assert_eq!(*ra, a);
                assert_eq!(*rb, c);
            }
            other => panic!("expected split: {other:?}"),
        }
        assert_eq!(t.leaf_ids(), vec![a, c]);
    }

    #[test]
    fn close_root_leaf_is_noop() {
        let mut t = PaneTree::new();
        let root = t.root();
        assert_eq!(t.close(root), None);
        assert_eq!(t.leaf_ids(), vec![root]);
    }

    #[test]
    fn adjacent_walks_layout_order() {
        let mut t = PaneTree::new();
        let a = t.root();
        let b = t.split(a, SplitDir::Horizontal).unwrap();
        let c = t.split(b, SplitDir::Horizontal).unwrap();
        // Order: a, b, c
        assert_eq!(t.adjacent(a, Nav::Right), Some(b));
        assert_eq!(t.adjacent(b, Nav::Right), Some(c));
        assert_eq!(t.adjacent(c, Nav::Right), None);
        assert_eq!(t.adjacent(c, Nav::Left), Some(b));
        assert_eq!(t.adjacent(a, Nav::Left), None);
        // Down/Up behave like Right/Left (linear order).
        assert_eq!(t.adjacent(a, Nav::Down), Some(b));
        assert_eq!(t.adjacent(b, Nav::Up), Some(a));
    }

    #[test]
    fn set_ratio_clamps() {
        let mut t = PaneTree::new();
        let a = t.root();
        t.split(a, SplitDir::Horizontal).unwrap();
        let split = t.root();
        t.set_ratio(split, 0.05);
        assert!(matches!(t.get(split), Some(Pane::Split { ratio, .. }) if (*ratio - RATIO_MIN).abs() < 1e-6));
        t.set_ratio(split, 0.99);
        assert!(matches!(t.get(split), Some(Pane::Split { ratio, .. }) if (*ratio - RATIO_MAX).abs() < 1e-6));
        t.set_ratio(split, 0.42);
        assert!(matches!(t.get(split), Some(Pane::Split { ratio, .. }) if (*ratio - 0.42).abs() < 1e-6));
    }

    #[test]
    fn split_non_leaf_errors() {
        let mut t = PaneTree::new();
        let a = t.root();
        t.split(a, SplitDir::Horizontal).unwrap();
        let split = t.root();
        assert_eq!(t.split(split, SplitDir::Horizontal), Err(PaneError::NotALeaf(split)));
        assert_eq!(t.split(999, SplitDir::Horizontal), Err(PaneError::NotFound(999)));
    }

    #[test]
    fn terminal_and_explorer_ids_filter_by_type() {
        let mut t = PaneTree::new();
        let a = t.root();
        let b = t.split(a, SplitDir::Horizontal).unwrap();
        // Turn `b` into an explorer leaf.
        t.panes.insert(b, Pane::Explorer { cwd: None });
        assert_eq!(t.leaf_ids(), vec![a, b]);
        assert_eq!(t.terminal_ids(), vec![a]);
        assert_eq!(t.explorer_ids(), vec![b]);
    }
}
