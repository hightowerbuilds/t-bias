// ---------------------------------------------------------------------------
// Shared persistence utilities
// ---------------------------------------------------------------------------
// Atomic write + compact/pretty JSON helpers used by session.rs,
// shell_registry.rs, and prompt_stacker.rs.

use std::path::{Path, PathBuf};

/// Returns the platform config directory for tbias (`<config_dir>/tbias`).
/// Shared by session, shell_registry, and prompt_stacker modules.
pub fn tbias_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("tbias"))
}

/// Write `contents` to `path` atomically: write to a sibling temp file first,
/// then rename into place. On most filesystems rename is atomic, so readers
/// never see a half-written file.
///
/// If the write or rename fails, the temp file is cleaned up and the original
/// file (if any) is left untouched.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;

    // Temp file in the same directory so rename doesn't cross filesystems.
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("data"),
    ));

    if let Err(e) = std::fs::write(&tmp, contents) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write tmp: {e}"));
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename: {e}"));
    }

    Ok(())
}

/// Serialize `value` as compact JSON and write atomically. Used for
/// auto-session saves where file size matters more than readability.
pub fn atomic_write_json_compact(
    path: &Path,
    value: &impl serde::Serialize,
) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(path, json.as_bytes())
}

/// Serialize `value` as pretty JSON and write atomically. Used for
/// user-facing files (named sessions, config) where readability matters.
pub fn atomic_write_json_pretty(
    path: &Path,
    value: &impl serde::Serialize,
) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(path, json.as_bytes())
}
