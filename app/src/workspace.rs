// t-bias — workspace state (Phase 4).
//
// The layout state for the whole window: an ordered list of tabs, each a pane
// tree with an active pane and zoom flag, plus the active tab and id allocators.
// Ported from the Deno app's `src/workspace/store.ts` — but pure state only: the
// live terminal sessions and focus/font side effects are the UI's concern (the
// session cache keys on (tab id, pane id) since pane ids are per-tree here).
//
// This is the same struct the DB persists (`crate::db`), so no separate snapshot
// type. UI wiring lands with tab/split rendering (blocked on the render fix);
// this module is headless-testable.
#![allow(dead_code)]

use crate::pane_tree::{Nav, Pane, PaneId, PaneTree, SplitDir};

pub type TabId = u64;

/// One tab: a titled pane layout with an active pane and zoom flag.
#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub id: TabId,
    pub title: String,
    pub active_pane: PaneId,
    pub zoomed: bool,
    pub tree: PaneTree,
}

impl Tab {
    fn new(id: TabId) -> Self {
        let tree = PaneTree::new();
        let active_pane = tree.root();
        Self {
            id,
            title: "Shell".into(),
            active_pane,
            zoomed: false,
            tree,
        }
    }
}

/// The window's layout: ordered tabs, the active tab, and the tab-id allocator.
#[derive(Clone, Debug, PartialEq)]
pub struct Workspace {
    pub name: String,
    pub active_tab: TabId,
    pub next_tab_id: TabId,
    pub tabs: Vec<Tab>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

impl Workspace {
    /// A fresh workspace with a single tab holding one terminal pane.
    pub fn new() -> Self {
        let first = Tab::new(1);
        Self {
            name: "default".into(),
            active_tab: first.id,
            next_tab_id: 2,
            tabs: vec![first],
        }
    }

    fn alloc_tab(&mut self) -> TabId {
        let id = self.next_tab_id;
        self.next_tab_id += 1;
        id
    }

    fn index_of(&self, id: TabId) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    pub fn active_index(&self) -> Option<usize> {
        self.index_of(self.active_tab)
    }

    pub fn active(&self) -> Option<&Tab> {
        self.active_index().map(|i| &self.tabs[i])
    }

    pub fn active_mut(&mut self) -> Option<&mut Tab> {
        self.active_index().map(|i| &mut self.tabs[i])
    }

    pub fn tab(&self, id: TabId) -> Option<&Tab> {
        self.index_of(id).map(|i| &self.tabs[i])
    }

    /// Open a new tab (single terminal) and make it active. Returns its id.
    pub fn add_tab(&mut self) -> TabId {
        let id = self.alloc_tab();
        self.tabs.push(Tab::new(id));
        self.active_tab = id;
        id
    }

    /// Close a tab. If it was active, the neighbor becomes active. Closing the
    /// last tab opens a fresh one (the window always has at least one tab).
    pub fn close_tab(&mut self, id: TabId) {
        let Some(i) = self.index_of(id) else {
            return;
        };
        let was_active = id == self.active_tab;
        self.tabs.remove(i);

        if self.tabs.is_empty() {
            let fresh = self.add_tab();
            self.active_tab = fresh;
        } else if was_active {
            let next = i.min(self.tabs.len() - 1);
            self.active_tab = self.tabs[next].id;
        }
    }

    pub fn select_tab(&mut self, id: TabId) {
        if self.index_of(id).is_some() {
            self.active_tab = id;
        }
    }

    pub fn select_tab_index(&mut self, idx: usize) {
        if let Some(tab) = self.tabs.get(idx) {
            self.active_tab = tab.id;
        }
    }

    /// Cycle the active tab by `delta` (wraps).
    pub fn cycle_tab(&mut self, delta: isize) {
        let Some(i) = self.active_index() else {
            return;
        };
        let len = self.tabs.len() as isize;
        let next = ((i as isize + delta) % len + len) % len;
        self.active_tab = self.tabs[next as usize].id;
    }

    /// Split the active pane of the active tab; the new leaf becomes active.
    /// Returns the new pane id.
    pub fn split_active(&mut self, dir: SplitDir) -> Option<PaneId> {
        let tab = self.active_mut()?;
        let new_leaf = tab.tree.split(tab.active_pane, dir).ok()?;
        tab.active_pane = new_leaf;
        tab.zoomed = false;
        Some(new_leaf)
    }

    /// Close the active pane. If it's the only pane, close the whole tab.
    pub fn close_active_pane(&mut self) {
        let Some(tab) = self.active() else {
            return;
        };
        if tab.tree.leaf_ids().len() <= 1 {
            self.close_tab(tab.id);
            return;
        }
        // Safe: we just checked `active()` is Some.
        let tab = self.active_mut().unwrap();
        let closing = tab.active_pane;
        if let Some(focus) = tab.tree.close(closing) {
            tab.active_pane = focus;
            tab.zoomed = false;
        }
    }

    /// Set the active pane within the active tab (if it exists).
    pub fn activate_pane(&mut self, pane: PaneId) {
        if let Some(tab) = self.active_mut() {
            if tab.tree.get(pane).is_some() {
                tab.active_pane = pane;
            }
        }
    }

    /// Move focus to the pane adjacent to the active one (no-op when zoomed).
    pub fn navigate(&mut self, dir: Nav) {
        let Some(tab) = self.active() else {
            return;
        };
        if tab.zoomed {
            return;
        }
        if let Some(adj) = tab.tree.adjacent(tab.active_pane, dir) {
            self.activate_pane(adj);
        }
    }

    pub fn toggle_zoom(&mut self) {
        if let Some(tab) = self.active_mut() {
            tab.zoomed = !tab.zoomed;
        }
    }

    pub fn set_ratio(&mut self, split: PaneId, ratio: f32) {
        if let Some(tab) = self.active_mut() {
            tab.tree.set_ratio(split, ratio);
        }
    }

    /// Flip the active leaf between terminal and explorer, preserving its cwd.
    pub fn flip_active(&mut self) {
        let Some(tab) = self.active_mut() else {
            return;
        };
        let id = tab.active_pane;
        let flipped = match tab.tree.get(id) {
            Some(Pane::Terminal { cwd, .. }) => Pane::Explorer { cwd: cwd.clone() },
            Some(Pane::Explorer { cwd }) => Pane::Terminal {
                cwd: cwd.clone(),
                flipped: false,
            },
            _ => return,
        };
        tab.tree.replace_leaf(id, flipped);
    }

    /// A shell exited on its own (e.g. `exit`) — collapse its pane, or close the
    /// tab if it was the only pane.
    pub fn handle_shell_exit(&mut self, tab_id: TabId, pane: PaneId) {
        let Some(i) = self.index_of(tab_id) else {
            return;
        };
        if self.tabs[i].tree.leaf_ids().len() <= 1 {
            self.close_tab(tab_id);
            return;
        }
        let tab = &mut self.tabs[i];
        if let Some(focus) = tab.tree.close(pane) {
            if tab.active_pane == pane {
                tab.active_pane = focus;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_workspace_has_one_terminal_tab() {
        let ws = Workspace::new();
        assert_eq!(ws.tabs.len(), 1);
        assert_eq!(ws.active_tab, 1);
        let tab = ws.active().unwrap();
        assert_eq!(tab.tree.leaf_ids().len(), 1);
        assert!(matches!(tab.tree.get(tab.active_pane), Some(Pane::Terminal { .. })));
    }

    #[test]
    fn add_and_cycle_tabs() {
        let mut ws = Workspace::new();
        let t2 = ws.add_tab();
        let t3 = ws.add_tab();
        assert_eq!(ws.tabs.len(), 3);
        assert_eq!(ws.active_tab, t3);
        ws.cycle_tab(1); // wraps to first
        assert_eq!(ws.active_tab, 1);
        ws.cycle_tab(-1); // wraps back to last
        assert_eq!(ws.active_tab, t3);
        ws.select_tab(t2);
        assert_eq!(ws.active_tab, t2);
        ws.select_tab_index(0);
        assert_eq!(ws.active_tab, 1);
    }

    #[test]
    fn split_makes_new_pane_active() {
        let mut ws = Workspace::new();
        let root = ws.active().unwrap().active_pane;
        let new_pane = ws.split_active(SplitDir::Horizontal).unwrap();
        let tab = ws.active().unwrap();
        assert_eq!(tab.active_pane, new_pane);
        assert_ne!(new_pane, root);
        assert_eq!(tab.tree.leaf_ids(), vec![root, new_pane]);
    }

    #[test]
    fn close_active_pane_focuses_sibling() {
        let mut ws = Workspace::new();
        let root = ws.active().unwrap().active_pane;
        let b = ws.split_active(SplitDir::Horizontal).unwrap();
        assert_eq!(ws.active().unwrap().active_pane, b);
        ws.close_active_pane(); // closes b, focus back to root
        let tab = ws.active().unwrap();
        assert_eq!(tab.active_pane, root);
        assert_eq!(tab.tree.leaf_ids(), vec![root]);
    }

    #[test]
    fn close_only_pane_closes_the_tab() {
        let mut ws = Workspace::new();
        ws.add_tab(); // now 2 tabs, tab 2 active with a single pane
        assert_eq!(ws.tabs.len(), 2);
        ws.close_active_pane(); // single pane → whole tab closes
        assert_eq!(ws.tabs.len(), 1);
        assert_eq!(ws.active_tab, 1);
    }

    #[test]
    fn closing_last_tab_opens_a_fresh_one() {
        let mut ws = Workspace::new();
        let first = ws.active_tab;
        ws.close_tab(first);
        assert_eq!(ws.tabs.len(), 1);
        assert_ne!(ws.active_tab, first); // a brand new tab
        assert!(ws.active().is_some());
    }

    #[test]
    fn close_active_tab_activates_neighbor() {
        let mut ws = Workspace::new();
        let t2 = ws.add_tab();
        let _t3 = ws.add_tab(); // active
        ws.select_tab(t2);
        ws.close_tab(t2); // neighbor at same index (old t3) becomes active
        assert_eq!(ws.tabs.len(), 2);
        assert!(ws.index_of(ws.active_tab).is_some());
    }

    #[test]
    fn navigate_and_zoom() {
        let mut ws = Workspace::new();
        let root = ws.active().unwrap().active_pane;
        let b = ws.split_active(SplitDir::Horizontal).unwrap();
        ws.navigate(Nav::Left);
        assert_eq!(ws.active().unwrap().active_pane, root);
        ws.navigate(Nav::Right);
        assert_eq!(ws.active().unwrap().active_pane, b);
        // Zoom pins focus: navigation is a no-op while zoomed.
        ws.toggle_zoom();
        ws.navigate(Nav::Left);
        assert_eq!(ws.active().unwrap().active_pane, b);
    }

    #[test]
    fn flip_active_toggles_leaf_type() {
        let mut ws = Workspace::new();
        let id = ws.active().unwrap().active_pane;
        ws.flip_active();
        assert!(matches!(ws.active().unwrap().tree.get(id), Some(Pane::Explorer { .. })));
        ws.flip_active();
        assert!(matches!(ws.active().unwrap().tree.get(id), Some(Pane::Terminal { .. })));
    }

    #[test]
    fn shell_exit_collapses_pane_or_closes_tab() {
        let mut ws = Workspace::new();
        let tab_id = ws.active_tab;
        let root = ws.active().unwrap().active_pane;
        let b = ws.split_active(SplitDir::Horizontal).unwrap();
        // b's shell exits → collapse to root.
        ws.handle_shell_exit(tab_id, b);
        assert_eq!(ws.active().unwrap().tree.leaf_ids(), vec![root]);
        // root's shell exits → only pane → tab closes → fresh tab.
        ws.handle_shell_exit(tab_id, root);
        assert_eq!(ws.tabs.len(), 1);
        assert_ne!(ws.active_tab, tab_id);
    }
}
