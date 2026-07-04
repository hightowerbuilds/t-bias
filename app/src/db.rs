// t-bias — SQLite persistence (Phase 5).
//
// A direct, in-process rusqlite layer (no ORM). Serializes the workspace — tabs
// and their pane trees — into `workspaces` / `tabs` / `panes`, and records shell
// lifecycle in `shells`. The tree shape is stored via each split's `a`/`b`
// child pointers plus a recomputed `parent_id` (root = the pane with no parent),
// mirroring the Deno app's `db/`.
//
// Timestamps are passed in by the caller (millis) so this layer stays clock-free
// and unit-testable against an in-memory DB. UI wiring (autosave on layout
// change, save on quit, load on startup) lands with the Phase 4 workspace UI,
// which is blocked on the text-rendering fix.

// UI wiring (autosave, save-on-quit, load-on-startup) lands with the Phase 4
// workspace UI, blocked on the text-rendering fix — allow dead code until then.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::pane_tree::{Pane, PaneId, PaneTree, SplitDir};
use crate::workspace::{Tab, Workspace};

/// The single workspace we persist (multi-workspace is out of scope).
const WORKSPACE_ID: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workspaces (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    active_tab_id INTEGER NOT NULL,
    next_tab_id   INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tabs (
    id             INTEGER NOT NULL,
    workspace_id   INTEGER NOT NULL,
    title          TEXT NOT NULL,
    active_pane_id INTEGER NOT NULL,
    zoomed         INTEGER NOT NULL DEFAULT 0,
    sort_order     INTEGER NOT NULL,
    next_pane_id   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS panes (
    workspace_id INTEGER NOT NULL,
    tab_id       INTEGER NOT NULL,
    id           INTEGER NOT NULL,
    type         TEXT NOT NULL,
    parent_id    INTEGER,
    dir          TEXT,
    ratio        REAL,
    a            INTEGER,
    b            INTEGER,
    cwd          TEXT,
    flipped      INTEGER,
    PRIMARY KEY (workspace_id, tab_id, id)
);
CREATE TABLE IF NOT EXISTS shells (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pane_id    INTEGER NOT NULL,
    pid        INTEGER,
    command    TEXT,
    cwd        TEXT,
    status     TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER NOT NULL,
    exited_at  INTEGER
);
";

/// A shell lifecycle record.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellRecord {
    pub id: i64,
    pub pane_id: u64,
    pub pid: Option<i64>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub exited_at: Option<i64>,
}

/// `~/Library/Application Support/com.tbias.app/tbias.db`, creating the dir.
pub fn default_db_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME not set")?;
    let dir = PathBuf::from(home)
        .join("Library/Application Support/com.tbias.app");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating app-data dir {}", dir.display()))?;
    Ok(dir.join("tbias.db"))
}

/// Open (creating if needed) a DB at `path` and run migrations.
pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("opening db at {}", path.display()))?;
    migrate(&conn)?;
    Ok(conn)
}

/// An in-memory DB with migrations applied (tests, ephemeral sessions).
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA).context("running migrations")?;
    Ok(())
}

/// Replace the persisted workspace with `ws` (single transaction).
pub fn save_workspace(conn: &mut Connection, ws: &Workspace, updated_at: i64) -> Result<()> {
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO workspaces (id, name, active_tab_id, next_tab_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             name = ?2, active_tab_id = ?3, next_tab_id = ?4, updated_at = ?5",
        params![
            WORKSPACE_ID,
            ws.name,
            ws.active_tab as i64,
            ws.next_tab_id as i64,
            updated_at
        ],
    )?;

    // Rewrite tabs + panes wholesale — simplest correct snapshot.
    tx.execute("DELETE FROM panes WHERE workspace_id = ?1", params![WORKSPACE_ID])?;
    tx.execute("DELETE FROM tabs WHERE workspace_id = ?1", params![WORKSPACE_ID])?;

    for (sort_order, tab) in ws.tabs.iter().enumerate() {
        tx.execute(
            "INSERT INTO tabs (id, workspace_id, title, active_pane_id, zoomed, sort_order, next_pane_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                tab.id as i64,
                WORKSPACE_ID,
                tab.title,
                tab.active_pane as i64,
                tab.zoomed as i64,
                sort_order as i64,
                tab.tree.next_id() as i64
            ],
        )?;

        // Reachable panes only, with parent recomputed from the tree shape.
        let parents = compute_parents(&tab.tree);
        for (id, parent) in &parents {
            let Some(pane) = tab.tree.get(*id) else {
                continue;
            };
            let f = PaneFields::from(pane);
            tx.execute(
                "INSERT INTO panes
                     (workspace_id, tab_id, id, type, parent_id, dir, ratio, a, b, cwd, flipped)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    WORKSPACE_ID,
                    tab.id as i64,
                    *id as i64,
                    f.kind,
                    parent.map(|p| p as i64),
                    f.dir,
                    f.ratio,
                    f.a.map(|x| x as i64),
                    f.b.map(|x| x as i64),
                    f.cwd,
                    f.flipped,
                ],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

/// Load the persisted workspace, or None if nothing has been saved.
pub fn load_workspace(conn: &Connection) -> Result<Option<Workspace>> {
    let ws = conn
        .query_row(
            "SELECT name, active_tab_id, next_tab_id FROM workspaces WHERE id = ?1",
            params![WORKSPACE_ID],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((name, active_tab, next_tab_id)) = ws else {
        return Ok(None);
    };

    let mut tab_stmt = conn.prepare(
        "SELECT id, title, active_pane_id, zoomed, next_pane_id
         FROM tabs WHERE workspace_id = ?1 ORDER BY sort_order",
    )?;
    let tab_rows: Vec<(i64, String, i64, i64, i64)> = tab_stmt
        .query_map(params![WORKSPACE_ID], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut tabs = Vec::with_capacity(tab_rows.len());
    for (tab_id, title, active_pane, zoomed, next_pane_id) in tab_rows {
        let (panes, root) = load_panes(conn, tab_id, active_pane)?;
        tabs.push(Tab {
            id: tab_id as u64,
            title,
            active_pane: active_pane as u64,
            zoomed: zoomed != 0,
            tree: PaneTree::from_parts(panes, root, next_pane_id as u64),
        });
    }

    Ok(Some(Workspace {
        name,
        active_tab: active_tab as u64,
        next_tab_id: next_tab_id as u64,
        tabs,
    }))
}

/// Load a tab's panes; returns the map and the root (pane with no parent).
fn load_panes(
    conn: &Connection,
    tab_id: i64,
    fallback_root: i64,
) -> Result<(HashMap<PaneId, Pane>, PaneId)> {
    let mut stmt = conn.prepare(
        "SELECT id, type, parent_id, dir, ratio, a, b, cwd, flipped
         FROM panes WHERE workspace_id = ?1 AND tab_id = ?2",
    )?;
    let rows = stmt.query_map(params![WORKSPACE_ID, tab_id], |r| {
        Ok(PaneRow {
            id: r.get(0)?,
            kind: r.get(1)?,
            parent_id: r.get(2)?,
            dir: r.get(3)?,
            ratio: r.get(4)?,
            a: r.get(5)?,
            b: r.get(6)?,
            cwd: r.get(7)?,
            flipped: r.get(8)?,
        })
    })?;

    let mut map = HashMap::new();
    let mut root = None;
    for row in rows {
        let row = row?;
        if row.parent_id.is_none() {
            root = Some(row.id as u64);
        }
        map.insert(row.id as u64, row.into_pane());
    }
    Ok((map, root.unwrap_or(fallback_root as u64)))
}

/// Insert a shell record on spawn; returns its rowid.
pub fn insert_shell(
    conn: &Connection,
    pane_id: u64,
    pid: Option<i64>,
    command: Option<&str>,
    cwd: Option<&str>,
    started_at: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO shells (pane_id, pid, command, cwd, status, started_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?5)",
        params![pane_id as i64, pid, command, cwd, started_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Mark a shell exited/crashed with an exit timestamp.
pub fn mark_shell_exited(conn: &Connection, id: i64, status: &str, exited_at: i64) -> Result<()> {
    conn.execute(
        "UPDATE shells SET status = ?1, exited_at = ?2 WHERE id = ?3",
        params![status, exited_at, id],
    )?;
    Ok(())
}

/// All shell records, oldest first.
pub fn list_shells(conn: &Connection) -> Result<Vec<ShellRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, pane_id, pid, command, cwd, status, started_at, exited_at
         FROM shells ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ShellRecord {
                id: r.get(0)?,
                pane_id: r.get::<_, i64>(1)? as u64,
                pid: r.get(2)?,
                command: r.get(3)?,
                cwd: r.get(4)?,
                status: r.get(5)?,
                started_at: r.get(6)?,
                exited_at: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Column values for a pane, ready to bind.
struct PaneFields {
    kind: &'static str,
    dir: Option<&'static str>,
    ratio: Option<f64>,
    a: Option<PaneId>,
    b: Option<PaneId>,
    cwd: Option<String>,
    flipped: Option<i64>,
}

impl From<&Pane> for PaneFields {
    fn from(pane: &Pane) -> Self {
        match pane {
            Pane::Terminal { cwd, flipped } => PaneFields {
                kind: "terminal",
                dir: None,
                ratio: None,
                a: None,
                b: None,
                cwd: cwd.clone(),
                flipped: Some(*flipped as i64),
            },
            Pane::Explorer { cwd } => PaneFields {
                kind: "explorer",
                dir: None,
                ratio: None,
                a: None,
                b: None,
                cwd: cwd.clone(),
                flipped: None,
            },
            Pane::Split { dir, ratio, a, b } => PaneFields {
                kind: "split",
                dir: Some(match dir {
                    SplitDir::Horizontal => "h",
                    SplitDir::Vertical => "v",
                }),
                ratio: Some(*ratio as f64),
                a: Some(*a),
                b: Some(*b),
                cwd: None,
                flipped: None,
            },
        }
    }
}

/// A raw pane row read back from the DB.
struct PaneRow {
    id: i64,
    kind: String,
    parent_id: Option<i64>,
    dir: Option<String>,
    ratio: Option<f64>,
    a: Option<i64>,
    b: Option<i64>,
    cwd: Option<String>,
    flipped: Option<i64>,
}

impl PaneRow {
    fn into_pane(self) -> Pane {
        match self.kind.as_str() {
            "split" => Pane::Split {
                dir: if self.dir.as_deref() == Some("v") {
                    SplitDir::Vertical
                } else {
                    SplitDir::Horizontal
                },
                ratio: self.ratio.unwrap_or(0.5) as f32,
                a: self.a.unwrap_or(0) as u64,
                b: self.b.unwrap_or(0) as u64,
            },
            "explorer" => Pane::Explorer { cwd: self.cwd },
            _ => Pane::Terminal {
                cwd: self.cwd,
                flipped: self.flipped.unwrap_or(0) != 0,
            },
        }
    }
}

/// Recompute each pane's parent from the tree shape (root → None).
fn compute_parents(tree: &PaneTree) -> HashMap<PaneId, Option<PaneId>> {
    fn visit(
        tree: &PaneTree,
        parent: Option<PaneId>,
        id: PaneId,
        out: &mut HashMap<PaneId, Option<PaneId>>,
    ) {
        out.insert(id, parent);
        if let Some(Pane::Split { a, b, .. }) = tree.get(id) {
            visit(tree, Some(id), *a, out);
            visit(tree, Some(id), *b, out);
        }
    }
    let mut out = HashMap::new();
    visit(tree, None, tree.root(), &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_workspace() -> Workspace {
        // Tab 1: a horizontal split, active on the new pane, zoomed.
        let mut t1 = PaneTree::new();
        let root1 = t1.root();
        let leaf1b = t1.split(root1, SplitDir::Horizontal).unwrap();
        t1.set_ratio(t1.root(), 0.75);

        // Tab 2: a fresh single terminal with a cwd.
        let t2 = PaneTree::from_parts(
            {
                let mut m = HashMap::new();
                m.insert(
                    1,
                    Pane::Terminal {
                        cwd: Some("/work".into()),
                        flipped: false,
                    },
                );
                m
            },
            1,
            2,
        );

        Workspace {
            name: "default".into(),
            active_tab: 1,
            next_tab_id: 3,
            tabs: vec![
                Tab {
                    id: 1,
                    title: "shell".into(),
                    active_pane: leaf1b,
                    zoomed: true,
                    tree: t1,
                },
                Tab {
                    id: 2,
                    title: "work".into(),
                    active_pane: 1,
                    zoomed: false,
                    tree: t2,
                },
            ],
        }
    }

    #[test]
    fn load_empty_is_none() {
        let conn = open_in_memory().unwrap();
        assert_eq!(load_workspace(&conn).unwrap(), None);
    }

    #[test]
    fn workspace_round_trips() {
        let mut conn = open_in_memory().unwrap();
        let ws = sample_workspace();
        save_workspace(&mut conn, &ws, 1_000).unwrap();
        let loaded = load_workspace(&conn).unwrap().expect("workspace present");
        assert_eq!(loaded, ws);
    }

    #[test]
    fn save_is_idempotent_replace() {
        let mut conn = open_in_memory().unwrap();
        let ws = sample_workspace();
        save_workspace(&mut conn, &ws, 1_000).unwrap();
        // Save a smaller workspace; the old tabs/panes must be gone.
        let mut small = ws.clone();
        small.tabs.truncate(1);
        save_workspace(&mut conn, &small, 2_000).unwrap();
        let loaded = load_workspace(&conn).unwrap().unwrap();
        assert_eq!(loaded.tabs.len(), 1);
        assert_eq!(loaded, small);
    }

    #[test]
    fn split_tree_shape_survives() {
        let mut conn = open_in_memory().unwrap();
        let ws = sample_workspace();
        save_workspace(&mut conn, &ws, 1).unwrap();
        let loaded = load_workspace(&conn).unwrap().unwrap();
        let tab1 = &loaded.tabs[0];
        // Root is a split with ratio 0.75 and two leaves in order.
        assert!(matches!(
            tab1.tree.get(tab1.tree.root()),
            Some(Pane::Split { ratio, .. }) if (*ratio - 0.75).abs() < 1e-6
        ));
        assert_eq!(tab1.tree.leaf_ids().len(), 2);
    }

    #[test]
    fn shell_records_insert_and_exit() {
        let conn = open_in_memory().unwrap();
        let id = insert_shell(&conn, 7, Some(4242), Some("/bin/zsh -l"), Some("/home"), 100).unwrap();
        mark_shell_exited(&conn, id, "exited", 200).unwrap();
        let shells = list_shells(&conn).unwrap();
        assert_eq!(shells.len(), 1);
        assert_eq!(
            shells[0],
            ShellRecord {
                id,
                pane_id: 7,
                pid: Some(4242),
                command: Some("/bin/zsh -l".into()),
                cwd: Some("/home".into()),
                status: "exited".into(),
                started_at: 100,
                exited_at: Some(200),
            }
        );
    }
}
