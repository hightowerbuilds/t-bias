use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRecord {
    pub id: String,
    pub text: String,
    pub created_at: u64,
}

fn tbias_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("tbias"))
}

fn prompts_path() -> Option<PathBuf> {
    Some(tbias_dir()?.join("prompt_stacker.json"))
}

fn load_prompts_inner() -> Result<Vec<PromptRecord>, String> {
    let path = match prompts_path() {
        Some(path) => path,
        None => return Ok(vec![]),
    };

    if !path.exists() {
        return Ok(vec![]);
    }

    let contents = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}

fn save_prompts_inner(prompts: &[PromptRecord]) -> Result<(), String> {
    let path = prompts_path().ok_or("no config directory")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(prompts).map_err(|e| e.to_string())?;
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
    load_prompts_inner().unwrap_or_default()
}

#[tauri::command]
pub fn save_prompt(text: String) -> Result<PromptRecord, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("prompt cannot be empty".to_string());
    }

    let mut prompts = load_prompts_inner()?;
    let prompt = PromptRecord {
        id: next_prompt_id(),
        text: trimmed.to_string(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };

    prompts.insert(0, prompt.clone());
    save_prompts_inner(&prompts)?;
    Ok(prompt)
}
