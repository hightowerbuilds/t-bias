// ---------------------------------------------------------------------------
// Filesystem operations — IPC commands for file explorer and code editor
// ---------------------------------------------------------------------------

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: Option<u64>,
}

#[derive(Serialize)]
pub struct ResolvedDirectory {
    requested_path: String,
    resolved_path: String,
    exact: bool,
}

fn resolve_existing_dir_path(path: &Path) -> Option<(PathBuf, bool)> {
    if path.as_os_str().is_empty() {
      return dirs::home_dir().map(|home| (home, false));
    }

    if path.is_dir() {
        return Some((path.to_path_buf(), true));
    }

    let mut candidate = path.to_path_buf();
    let exact = false;

    if candidate.exists() && !candidate.is_dir() {
        candidate.pop();
    }

    loop {
        if candidate.is_dir() {
            return Some((candidate, exact));
        }
        if !candidate.pop() {
            break;
        }
    }

    dirs::home_dir().map(|home| (home, false))
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result: Vec<DirEntry> = Vec::new();

    for entry in entries.flatten() {
        let meta = entry.metadata();
        let name = entry.file_name().to_string_lossy().into_owned();

        // Skip hidden files/dirs (starting with .)
        if name.starts_with('.') {
            continue;
        }

        let (is_dir, size, modified) = match &meta {
            Ok(m) => (
                m.is_dir(),
                m.len(),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
            ),
            Err(_) => (false, 0, None),
        };

        result.push(DirEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name,
            is_dir,
            size,
            modified,
        });
    }

    // Sort: directories first, then alphabetical
    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_entry(src: String, dest: String) -> Result<(), String> {
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_entry(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "could not determine home directory".to_string())
}

#[tauri::command]
pub fn resolve_existing_dir(path: String) -> Result<ResolvedDirectory, String> {
    let requested = path.clone();
    let requested_path = PathBuf::from(path);
    let (resolved_path, exact) = resolve_existing_dir_path(&requested_path)
        .ok_or_else(|| "could not determine a restore directory".to_string())?;

    Ok(ResolvedDirectory {
        requested_path: requested,
        resolved_path: resolved_path.to_string_lossy().into_owned(),
        exact,
    })
}

#[cfg(test)]
mod tests {
    use super::resolve_existing_dir_path;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("tbias-{name}-{nanos}"))
    }

    #[test]
    fn keeps_exact_existing_directory() {
        let dir = unique_temp_dir("exact-dir");
        fs::create_dir_all(&dir).unwrap();

        let (resolved, exact) = resolve_existing_dir_path(&dir).unwrap();
        assert_eq!(resolved, dir);
        assert!(exact);

        fs::remove_dir_all(resolved).unwrap();
    }

    #[test]
    fn falls_back_to_nearest_existing_parent() {
        let base = unique_temp_dir("ancestor-dir");
        let existing = base.join("workspace");
        let missing = existing.join("nested").join("missing");
        fs::create_dir_all(&existing).unwrap();

        let (resolved, exact) = resolve_existing_dir_path(&missing).unwrap();
        assert_eq!(resolved, existing);
        assert!(!exact);

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn converts_existing_file_path_to_parent_directory() {
        let base = unique_temp_dir("file-parent");
        fs::create_dir_all(&base).unwrap();
        let file = base.join("note.md");
        fs::write(&file, "hello").unwrap();

        let (resolved, exact) = resolve_existing_dir_path(&file).unwrap();
        assert_eq!(resolved, base);
        assert!(!exact);

        fs::remove_dir_all(base).unwrap();
    }
}
