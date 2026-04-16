use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontConfig {
    #[serde(default = "default_font_family")]
    pub family: String,
    #[serde(default = "default_font_size")]
    pub size: u32,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            family: default_font_family(),
            size: default_font_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorConfig {
    #[serde(default = "default_cursor_style")]
    pub style: String,
    #[serde(default = "default_cursor_blink")]
    pub blink: bool,
}

impl Default for CursorConfig {
    fn default() -> Self {
        Self {
            style: default_cursor_style(),
            blink: default_cursor_blink(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeConfig {
    #[serde(default = "default_background")]
    pub background: String,
    #[serde(default = "default_foreground")]
    pub foreground: String,
    #[serde(default = "default_cursor_color")]
    pub cursor: String,
    #[serde(default = "default_selection_bg")]
    pub selection_bg: String,
    #[serde(default = "default_ansi")]
    pub ansi: Vec<String>,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            background: default_background(),
            foreground: default_foreground(),
            cursor: default_cursor_color(),
            selection_bg: default_selection_bg(),
            ansi: default_ansi(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    /// "always" | "never" | "ask"
    #[serde(default = "default_restore_mode")]
    pub restore: String,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self { restore: default_restore_mode() }
    }
}

fn default_restore_mode() -> String {
    "ask".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub font: FontConfig,
    #[serde(default = "default_scrollback_limit")]
    pub scrollback_limit: u32,
    #[serde(default)]
    pub cursor: CursorConfig,
    #[serde(default = "default_shell")]
    pub shell: String,
    #[serde(default = "default_padding")]
    pub padding: u32,
    #[serde(default)]
    pub theme: ThemeConfig,
    #[serde(default)]
    pub session: SessionConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            font: FontConfig::default(),
            scrollback_limit: default_scrollback_limit(),
            cursor: CursorConfig::default(),
            shell: default_shell(),
            padding: default_padding(),
            theme: ThemeConfig::default(),
            session: SessionConfig::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Default value functions (used by serde)
// ---------------------------------------------------------------------------

fn default_font_family() -> String {
    "Menlo, Monaco, 'Courier New', monospace".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_scrollback_limit() -> u32 {
    5000
}

fn default_cursor_style() -> String {
    "block".to_string()
}

fn default_cursor_blink() -> bool {
    true
}

fn default_shell() -> String {
    String::new()
}

fn default_padding() -> u32 {
    8
}

fn default_background() -> String {
    "#1e1e1e".to_string()
}

fn default_foreground() -> String {
    "#d4d4d4".to_string()
}

fn default_cursor_color() -> String {
    "#d4d4d4".to_string()
}

fn default_selection_bg() -> String {
    "#264f78".to_string()
}

fn default_ansi() -> Vec<String> {
    vec![
        "#1e1e1e".to_string(), "#f44747".to_string(), "#6a9955".to_string(), "#d7ba7d".to_string(),
        "#569cd6".to_string(), "#c586c0".to_string(), "#4ec9b0".to_string(), "#d4d4d4".to_string(),
        "#808080".to_string(), "#f44747".to_string(), "#6a9955".to_string(), "#d7ba7d".to_string(),
        "#569cd6".to_string(), "#c586c0".to_string(), "#4ec9b0".to_string(), "#ffffff".to_string(),
    ]
}

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

fn config_path() -> Option<PathBuf> {
    let config_dir = dirs::config_dir()?;
    Some(config_dir.join("tbias").join("config.toml"))
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

/// Load configuration from the platform-appropriate config file.
/// Falls back to defaults if the file doesn't exist or has parse errors.
/// Partial configs are supported — serde fills in defaults for missing fields.
pub fn load_config() -> Config {
    let path = match config_path() {
        Some(p) => p,
        None => {
            log::info!("Could not determine config directory, using defaults");
            return Config::default();
        }
    };

    if !path.exists() {
        log::info!("No config file at {}, using defaults", path.display());
        return Config::default();
    }

    match std::fs::read_to_string(&path) {
        Ok(contents) => match toml::from_str::<Config>(&contents) {
            Ok(config) => {
                log::info!("Loaded config from {}", path.display());
                config
            }
            Err(e) => {
                log::warn!("Failed to parse config at {}: {}", path.display(), e);
                Config::default()
            }
        },
        Err(e) => {
            log::warn!("Failed to read config at {}: {}", path.display(), e);
            Config::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_config() -> Config {
    load_config()
}
