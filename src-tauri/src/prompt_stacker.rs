use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRecord {
    pub id: String,
    pub text: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PromptStackerState {
    pub prompts: Vec<PromptRecord>,
    pub queue: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum PromptStackerFile {
    State(PromptStackerState),
    LegacyPrompts(Vec<PromptRecord>),
}

fn tbias_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("tbias"))
}

fn prompts_path() -> Option<PathBuf> {
    Some(tbias_dir()?.join("prompt_stacker.json"))
}

fn normalize_state(state: PromptStackerState) -> PromptStackerState {
    let prompt_ids: HashSet<&str> = state.prompts.iter().map(|prompt| prompt.id.as_str()).collect();
    let mut seen = HashSet::new();
    let mut queue = Vec::new();

    for id in state.queue {
        if !prompt_ids.contains(id.as_str()) {
            continue;
        }
        if seen.insert(id.clone()) {
            queue.push(id);
        }
    }

    PromptStackerState {
        prompts: state.prompts,
        queue,
    }
}

fn load_prompt_stacker_state_inner() -> Result<PromptStackerState, String> {
    let path = match prompts_path() {
        Some(path) => path,
        None => return Ok(PromptStackerState::default()),
    };

    if !path.exists() {
        return Ok(PromptStackerState::default());
    }

    let contents = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed: PromptStackerFile = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    let state = match parsed {
        PromptStackerFile::State(state) => state,
        PromptStackerFile::LegacyPrompts(prompts) => PromptStackerState {
            prompts,
            queue: vec![],
        },
    };

    Ok(normalize_state(state))
}

fn save_prompt_stacker_state_inner(state: &PromptStackerState) -> Result<(), String> {
    let path = prompts_path().ok_or("no config directory")?;
    let normalized = normalize_state(state.clone());
    if let Err(e) = crate::persistence::atomic_write_json_pretty(&path, &normalized) {
        log::error!("save_prompt_stacker_state failed: {e}");
        return Err(e);
    }
    Ok(())
}

fn next_prompt_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_nanos())
}

#[tauri::command]
pub fn get_prompt_stacker_state() -> PromptStackerState {
    load_prompt_stacker_state_inner().unwrap_or_default()
}

#[tauri::command]
pub fn save_prompt(text: String) -> Result<PromptRecord, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("prompt cannot be empty".to_string());
    }

    let mut state = load_prompt_stacker_state_inner()?;
    let prompt = PromptRecord {
        id: next_prompt_id(),
        text: trimmed.to_string(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };

    state.prompts.insert(0, prompt.clone());
    save_prompt_stacker_state_inner(&state)?;
    Ok(prompt)
}

#[tauri::command]
pub fn edit_prompt(prompt_id: String, text: String) -> Result<PromptRecord, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("prompt cannot be empty".to_string());
    }

    let mut state = load_prompt_stacker_state_inner()?;
    let prompt = state
        .prompts
        .iter_mut()
        .find(|p| p.id == prompt_id)
        .ok_or("prompt not found")?;
    prompt.text = trimmed.to_string();
    let updated = prompt.clone();
    save_prompt_stacker_state_inner(&state)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_prompt(prompt_id: String) -> Result<PromptStackerState, String> {
    let mut state = load_prompt_stacker_state_inner()?;
    state.prompts.retain(|p| p.id != prompt_id);
    // normalize_state automatically cleans up queue references to deleted prompts.
    let normalized = normalize_state(state);
    save_prompt_stacker_state_inner(&normalized)?;
    Ok(normalized)
}

#[tauri::command]
pub fn duplicate_prompt(prompt_id: String) -> Result<PromptRecord, String> {
    let mut state = load_prompt_stacker_state_inner()?;
    let source = state
        .prompts
        .iter()
        .find(|p| p.id == prompt_id)
        .ok_or("prompt not found")?;
    let duplicate = PromptRecord {
        id: next_prompt_id(),
        text: source.text.clone(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    // Insert right after the source prompt.
    let idx = state.prompts.iter().position(|p| p.id == prompt_id).unwrap_or(0);
    state.prompts.insert(idx + 1, duplicate.clone());
    save_prompt_stacker_state_inner(&state)?;
    Ok(duplicate)
}

#[tauri::command]
pub fn set_prompt_queue(queue: Vec<String>) -> Result<PromptStackerState, String> {
    let mut state = load_prompt_stacker_state_inner()?;
    state.queue = queue;
    let normalized = normalize_state(state);
    save_prompt_stacker_state_inner(&normalized)?;
    Ok(normalized)
}

#[tauri::command]
pub fn export_prompts() -> Result<String, String> {
    let state = load_prompt_stacker_state_inner()?;
    serde_json::to_string_pretty(&state.prompts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_prompts(json: String) -> Result<PromptStackerState, String> {
    let imported: Vec<PromptRecord> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut state = load_prompt_stacker_state_inner()?;
    // Deduplicate by ID — imported prompts with existing IDs are skipped.
    let existing_ids: std::collections::HashSet<String> =
        state.prompts.iter().map(|p| p.id.clone()).collect();
    for prompt in imported {
        if !existing_ids.contains(&prompt.id) {
            state.prompts.push(prompt);
        }
    }
    // Sort by created_at descending (newest first).
    state.prompts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let normalized = normalize_state(state);
    save_prompt_stacker_state_inner(&normalized)?;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, text: &str) -> PromptRecord {
        PromptRecord { id: id.to_string(), text: text.to_string(), created_at: 1 }
    }

    #[test]
    fn normalize_removes_queue_refs_to_deleted_prompts() {
        let state = PromptStackerState {
            prompts: vec![p("a", "Alpha"), p("b", "Beta")],
            queue: vec!["a".into(), "gone".into(), "b".into()],
        };
        let result = normalize_state(state);
        assert_eq!(result.queue, vec!["a", "b"]);
    }

    #[test]
    fn normalize_deduplicates_queue() {
        let state = PromptStackerState {
            prompts: vec![p("a", "Alpha")],
            queue: vec!["a".into(), "a".into(), "a".into()],
        };
        let result = normalize_state(state);
        assert_eq!(result.queue, vec!["a"]);
    }

    #[test]
    fn legacy_json_migration() {
        // Legacy format: just an array of prompts (no queue wrapper)
        let json = r#"[{"id":"1","text":"Hello","created_at":1}]"#;
        let parsed: PromptStackerFile = serde_json::from_str(json).unwrap();
        match parsed {
            PromptStackerFile::LegacyPrompts(prompts) => {
                assert_eq!(prompts.len(), 1);
                assert_eq!(prompts[0].text, "Hello");
            }
            _ => panic!("expected LegacyPrompts variant"),
        }
    }

    #[test]
    fn current_json_format() {
        let json = r#"{"prompts":[{"id":"1","text":"Hello","created_at":1}],"queue":["1"]}"#;
        let parsed: PromptStackerFile = serde_json::from_str(json).unwrap();
        match parsed {
            PromptStackerFile::State(state) => {
                assert_eq!(state.prompts.len(), 1);
                assert_eq!(state.queue, vec!["1"]);
            }
            _ => panic!("expected State variant"),
        }
    }
}
