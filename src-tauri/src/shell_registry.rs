use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShellRecordStatus {
    Active,
    Detached,
    Closed,
    Crashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellRecord {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub last_attached_at: u64,
    pub last_known_cwd: Option<String>,
    pub shell_path: Option<String>,
    pub status: ShellRecordStatus,
    pub persist_on_quit: bool,
    pub closed_at: Option<u64>,
}

fn tbias_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("tbias"))
}

fn shell_registry_path() -> Option<PathBuf> {
    Some(tbias_dir()?.join("shell_registry.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn next_shell_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_nanos())
}

fn sort_records(records: &mut [ShellRecord]) {
    records.sort_by(|a, b| {
        b.last_attached_at
            .cmp(&a.last_attached_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn load_shell_registry_inner() -> Result<Vec<ShellRecord>, String> {
    let path = match shell_registry_path() {
        Some(path) => path,
        None => return Ok(vec![]),
    };

    if !path.exists() {
        return Ok(vec![]);
    }

    let contents = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut records: Vec<ShellRecord> = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    sort_records(&mut records);
    Ok(records)
}

fn save_shell_registry_inner(records: &[ShellRecord]) -> Result<(), String> {
    let path = shell_registry_path().ok_or("no config directory")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut next_records = records.to_vec();
    sort_records(&mut next_records);
    let json = serde_json::to_string_pretty(&next_records).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn normalize_records_for_launch(records: &mut [ShellRecord]) -> bool {
    let mut changed = false;
    let now = now_secs();

    for record in records.iter_mut() {
      match record.status {
          ShellRecordStatus::Active => {
              if record.persist_on_quit {
                  record.status = ShellRecordStatus::Detached;
                  record.closed_at = None;
              } else {
                  record.status = ShellRecordStatus::Closed;
                  record.closed_at = Some(now);
              }
              changed = true;
          }
          ShellRecordStatus::Detached if !record.persist_on_quit => {
              record.status = ShellRecordStatus::Closed;
              record.closed_at = Some(now);
              changed = true;
          }
          _ => {}
      }
    }

    changed
}

fn find_record_mut<'a>(records: &'a mut [ShellRecord], shell_id: &str) -> Result<&'a mut ShellRecord, String> {
    records
        .iter_mut()
        .find(|record| record.id == shell_id)
        .ok_or_else(|| format!("shell record not found: {}", shell_id))
}

#[tauri::command]
pub fn prepare_shell_registry_for_launch() -> Result<Vec<ShellRecord>, String> {
    let mut records = load_shell_registry_inner()?;
    if normalize_records_for_launch(&mut records) {
        save_shell_registry_inner(&records)?;
    }
    sort_records(&mut records);
    Ok(records)
}

#[tauri::command]
pub fn list_shell_records() -> Result<Vec<ShellRecord>, String> {
    let mut records = load_shell_registry_inner()?;
    sort_records(&mut records);
    Ok(records)
}

#[tauri::command]
pub fn create_shell_record(
    cwd: Option<String>,
    shell: Option<String>,
    title: Option<String>,
    persist_on_quit: Option<bool>,
) -> Result<ShellRecord, String> {
    let mut records = load_shell_registry_inner()?;
    let now = now_secs();
    let record = ShellRecord {
        id: next_shell_id(),
        title: title.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "Shell".to_string()),
        created_at: now,
        last_attached_at: now,
        last_known_cwd: cwd.filter(|value| !value.trim().is_empty()),
        shell_path: shell.filter(|value| !value.trim().is_empty()),
        status: ShellRecordStatus::Active,
        persist_on_quit: persist_on_quit.unwrap_or(false),
        closed_at: None,
    };
    records.push(record.clone());
    save_shell_registry_inner(&records)?;
    Ok(record)
}

#[tauri::command]
pub fn attach_shell_record(
    shell_id: String,
    cwd: Option<String>,
    title: Option<String>,
) -> Result<ShellRecord, String> {
    let mut records = load_shell_registry_inner()?;
    let now = now_secs();
    let record = find_record_mut(&mut records, &shell_id)?;
    record.last_attached_at = now;
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        record.title = title;
    }
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        record.last_known_cwd = Some(cwd);
    }
    record.status = ShellRecordStatus::Active;
    record.closed_at = None;
    let updated = record.clone();
    save_shell_registry_inner(&records)?;
    Ok(updated)
}

#[tauri::command]
pub fn update_shell_record(
    shell_id: String,
    title: Option<String>,
    cwd: Option<String>,
    status: Option<ShellRecordStatus>,
) -> Result<ShellRecord, String> {
    let mut records = load_shell_registry_inner()?;
    let now = now_secs();
    let record = find_record_mut(&mut records, &shell_id)?;
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        record.title = title;
    }
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        record.last_known_cwd = Some(cwd);
    }
    if let Some(status) = status {
        record.status = status.clone();
        record.closed_at = if status == ShellRecordStatus::Closed {
            Some(now)
        } else {
            None
        };
    }
    let updated = record.clone();
    save_shell_registry_inner(&records)?;
    Ok(updated)
}

#[tauri::command]
pub fn close_shell_record(shell_id: String) -> Result<ShellRecord, String> {
    let mut records = load_shell_registry_inner()?;
    let now = now_secs();
    let record = find_record_mut(&mut records, &shell_id)?;
    record.status = ShellRecordStatus::Closed;
    record.closed_at = Some(now);
    let updated = record.clone();
    save_shell_registry_inner(&records)?;
    Ok(updated)
}

#[tauri::command]
pub fn set_shell_persist_on_quit(
    shell_id: String,
    persist_on_quit: bool,
) -> Result<ShellRecord, String> {
    let mut records = load_shell_registry_inner()?;
    let now = now_secs();
    let record = find_record_mut(&mut records, &shell_id)?;
    record.persist_on_quit = persist_on_quit;
    if !persist_on_quit && record.status == ShellRecordStatus::Detached {
        record.status = ShellRecordStatus::Closed;
        record.closed_at = Some(now);
    }
    let updated = record.clone();
    save_shell_registry_inner(&records)?;
    Ok(updated)
}

#[tauri::command]
pub fn prepare_shell_registry_for_shutdown(active_shell_ids: Vec<String>) -> Result<(), String> {
    let mut records = load_shell_registry_inner()?;
    let active_ids: HashSet<String> = active_shell_ids.into_iter().collect();
    let now = now_secs();
    let mut changed = false;

    for record in records.iter_mut() {
        let should_transition = active_ids.contains(&record.id) || record.status == ShellRecordStatus::Active;
        if !should_transition {
            continue;
        }

        if record.persist_on_quit {
            if record.status != ShellRecordStatus::Detached || record.closed_at.is_some() {
                record.status = ShellRecordStatus::Detached;
                record.closed_at = None;
                changed = true;
            }
        } else if record.status != ShellRecordStatus::Closed || record.closed_at.is_none() {
            record.status = ShellRecordStatus::Closed;
            record.closed_at = Some(now);
            changed = true;
        }
    }

    if changed {
        save_shell_registry_inner(&records)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_records_for_launch, now_secs, prepare_shell_registry_for_shutdown, save_shell_registry_inner, load_shell_registry_inner, ShellRecord, ShellRecordStatus};

    fn record(id: &str, persist_on_quit: bool, status: ShellRecordStatus) -> ShellRecord {
        ShellRecord {
            id: id.to_string(),
            title: "Shell".to_string(),
            created_at: 1,
            last_attached_at: 1,
            last_known_cwd: Some("/tmp".to_string()),
            shell_path: Some("/bin/zsh".to_string()),
            status,
            persist_on_quit,
            closed_at: None,
        }
    }

    #[test]
    fn launch_normalization_detaches_persisted_active_shells() {
        let mut records = vec![
            record("keep", true, ShellRecordStatus::Active),
            record("close", false, ShellRecordStatus::Active),
        ];

        let changed = normalize_records_for_launch(&mut records);

        assert!(changed);
        assert_eq!(records[0].status, ShellRecordStatus::Detached);
        assert_eq!(records[0].closed_at, None);
        assert_eq!(records[1].status, ShellRecordStatus::Closed);
        assert!(records[1].closed_at.is_some());
    }
}
