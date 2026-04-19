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
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let normalized = normalize_state(state.clone());
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn next_prompt_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_nanos())
}

#[tauri::command]
pub fn list_prompts() -> Vec<PromptRecord> {
    load_prompt_stacker_state_inner()
        .map(|state| state.prompts)
        .unwrap_or_default()
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
pub fn set_prompt_queue(queue: Vec<String>) -> Result<PromptStackerState, String> {
    let mut state = load_prompt_stacker_state_inner()?;
    state.queue = queue;
    let normalized = normalize_state(state);
    save_prompt_stacker_state_inner(&normalized)?;
    Ok(normalized)
}
