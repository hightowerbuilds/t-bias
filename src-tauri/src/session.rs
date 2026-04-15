// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
// Saves/loads the tab+pane layout as JSON.
// The session file only stores layout structure (no content), so restoring
// means spawning fresh PTYs in the same arrangement.
//
// Auto-session:  ~/.config/tbias/session.json
// Named sessions: ~/.config/tbias/sessions/<name>.json

use serde_json::Value;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn tbias_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("tbias"))
}

fn auto_session_path() -> Option<PathBuf> {
    Some(tbias_dir()?.join("session.json"))
}

fn named_sessions_dir() -> Option<PathBuf> {
    Some(tbias_dir()?.join("sessions"))
}

/// Sanitize a session name to a safe filename component.
fn sanitize_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    // Replace spaces with underscores and strip leading/trailing junk
    s.replace(' ', "_")
        .trim_matches('_')
        .to_string()
}

fn named_session_path(name: &str) -> Option<PathBuf> {
    let safe = sanitize_name(name);
    if safe.is_empty() {
        return None;
    }
    Some(named_sessions_dir()?.join(format!("{}.json", safe)))
}

// ---------------------------------------------------------------------------
// Auto-session commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_session(data: Value) -> Result<(), String> {
    let path = auto_session_path().ok_or("no config directory")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Returns the saved session, or null if none exists.
#[tauri::command]
pub fn load_session() -> Option<Value> {
    let path = auto_session_path()?;
    if !path.exists() {
        return None;
    }
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

// ---------------------------------------------------------------------------
// Named-session commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_named_session(name: String, data: Value) -> Result<(), String> {
    let path = named_session_path(&name).ok_or("invalid session name")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Returns the named session, or null if it doesn't exist.
#[tauri::command]
pub fn load_named_session(name: String) -> Option<Value> {
    let path = named_session_path(&name)?;
    if !path.exists() {
        return None;
    }
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Returns all saved session names, sorted alphabetically.
#[tauri::command]
pub fn list_named_sessions() -> Vec<String> {
    let dir = match named_sessions_dir() {
        Some(d) => d,
        None => return vec![],
    };
    if !dir.exists() {
        return vec![];
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()?.to_str() == Some("json") {
                path.file_stem()?.to_str().map(str::to_string)
            } else {
                None
            }
        })
        .collect();
    names.sort();
    names
}

#[tauri::command]
pub fn delete_named_session(name: String) -> Result<(), String> {
    let path = named_session_path(&name).ok_or("invalid session name")?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
