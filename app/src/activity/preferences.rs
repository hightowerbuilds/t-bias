use super::model::{Scope, Sort};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub version: u32,
    pub scope: Scope,
    pub sort: Sort,
    pub descending: bool,
    pub tree: bool,
    pub columns: BTreeSet<Sort>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            scope: Scope::All,
            sort: Sort::Cpu,
            descending: true,
            tree: false,
            columns: [
                Sort::Name,
                Sort::Pid,
                Sort::Owner,
                Sort::Cpu,
                Sort::Memory,
                Sort::Threads,
                Sort::State,
            ]
            .into_iter()
            .collect(),
        }
    }
}
impl Preferences {
    fn validate(&mut self) -> Result<()> {
        if self.version != 1 {
            bail!(
                "unsupported Activity Monitor settings version {}",
                self.version
            );
        }
        self.columns.insert(Sort::Name);
        Ok(())
    }
}
fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(250))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS activity_settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);")?;
    Ok(conn)
}
pub fn load(path: &Path) -> Result<Preferences> {
    read(&open(path)?)
}
fn read(conn: &Connection) -> Result<Preferences> {
    let raw: Option<String> = conn
        .query_row("SELECT json FROM activity_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    let mut prefs: Preferences = raw
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default();
    prefs.validate()?;
    Ok(prefs)
}
pub fn save(path: &Path, prefs: &Preferences) -> Result<()> {
    write(&open(path)?, prefs)
}
fn write(conn: &Connection, prefs: &Preferences) -> Result<()> {
    let mut validated = prefs.clone();
    validated.validate()?;
    conn.execute("INSERT INTO activity_settings(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![serde_json::to_string(&validated)?])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versioned_preferences_preserve_workspace_and_omit_live_state() {
        let mut conn = crate::db::open_in_memory().unwrap();
        let ws = crate::workspace::Workspace::default();
        crate::db::save_workspace(&mut conn, &ws, 1).unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_settings(id INTEGER PRIMARY KEY,json TEXT NOT NULL)",
        )
        .unwrap();
        let p = Preferences {
            scope: Scope::Workspace,
            sort: Sort::Memory,
            tree: true,
            columns: [Sort::Name, Sort::Memory].into_iter().collect(),
            ..Default::default()
        };
        write(&conn, &p).unwrap();
        assert_eq!(read(&conn).unwrap(), p);
        assert_eq!(crate::db::load_workspace(&conn).unwrap().unwrap(), ws);
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("pid") && !json.contains("selected") && !json.contains("query"));
        conn.execute("UPDATE activity_settings SET json=?1", [r#"{"version":2}"#])
            .unwrap();
        assert!(read(&conn).is_err());
    }
}
