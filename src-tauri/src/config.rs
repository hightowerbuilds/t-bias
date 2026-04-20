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
    /// Optional preset name: "dark" (default), "dracula", "solarized-dark",
    /// "one-dark", "catppuccin-mocha". When set, overrides individual color
    /// fields that are not explicitly specified.
    #[serde(default)]
    pub preset: Option<String>,
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
            preset: None,
            background: default_background(),
            foreground: default_foreground(),
            cursor: default_cursor_color(),
            selection_bg: default_selection_bg(),
            ansi: default_ansi(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellsConfig {
    /// "always" | "never" | "ask"
    #[serde(default = "default_restore_mode")]
    pub restore: String,
    #[serde(default = "default_persist_on_quit")]
    pub persist_on_quit: bool,
}

impl Default for ShellsConfig {
    fn default() -> Self {
        Self {
            restore: default_restore_mode(),
            persist_on_quit: default_persist_on_quit(),
        }
    }
}

fn default_restore_mode() -> String {
    "ask".to_string()
}

fn default_persist_on_quit() -> bool {
    false
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
    /// Window opacity (0.0 = fully transparent, 1.0 = fully opaque).
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub theme: ThemeConfig,
    #[serde(default)]
    pub shells: ShellsConfig,
    #[serde(default)]
    pub keybindings: KeybindingsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingsConfig {
    #[serde(default = "default_kb_new_tab")]
    pub new_tab: String,
    #[serde(default = "default_kb_close")]
    pub close: String,
    #[serde(default = "default_kb_split_h")]
    pub split_horizontal: String,
    #[serde(default = "default_kb_split_v")]
    pub split_vertical: String,
    #[serde(default = "default_kb_zoom")]
    pub zoom: String,
    #[serde(default = "default_kb_flip")]
    pub flip: String,
    #[serde(default = "default_kb_advance_queue")]
    pub advance_queue: String,
}

impl Default for KeybindingsConfig {
    fn default() -> Self {
        Self {
            new_tab: default_kb_new_tab(),
            close: default_kb_close(),
            split_horizontal: default_kb_split_h(),
            split_vertical: default_kb_split_v(),
            zoom: default_kb_zoom(),
            flip: default_kb_flip(),
            advance_queue: default_kb_advance_queue(),
        }
    }
}

fn default_kb_new_tab() -> String { "Cmd+T".to_string() }
fn default_kb_close() -> String { "Cmd+W".to_string() }
fn default_kb_split_h() -> String { "Cmd+D".to_string() }
fn default_kb_split_v() -> String { "Cmd+Shift+D".to_string() }
fn default_kb_zoom() -> String { "Cmd+Shift+Enter".to_string() }
fn default_kb_flip() -> String { "Cmd+/".to_string() }
fn default_kb_advance_queue() -> String { "Cmd+Shift+Q".to_string() }

impl Default for Config {
    fn default() -> Self {
        Self {
            font: FontConfig::default(),
            scrollback_limit: default_scrollback_limit(),
            cursor: CursorConfig::default(),
            shell: default_shell(),
            padding: default_padding(),
            opacity: default_opacity(),
            theme: ThemeConfig::default(),
            shells: ShellsConfig::default(),
            keybindings: KeybindingsConfig::default(),
        }
    }
}

fn default_opacity() -> f64 {
    1.0
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
// Built-in theme presets
// ---------------------------------------------------------------------------

fn apply_theme_preset(theme: &mut ThemeConfig) {
    let preset = match theme.preset.as_deref() {
        Some(p) => p,
        None => return,
    };

    let (bg, fg, cursor, sel, ansi) = match preset {
        "dracula" => (
            "#282a36", "#f8f8f2", "#f8f8f2", "#44475a",
            vec![
                "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
                "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
                "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
                "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
            ],
        ),
        "solarized-dark" => (
            "#002b36", "#839496", "#839496", "#073642",
            vec![
                "#073642", "#dc322f", "#859900", "#b58900",
                "#268bd2", "#d33682", "#2aa198", "#eee8d5",
                "#002b36", "#cb4b16", "#586e75", "#657b83",
                "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
            ],
        ),
        "one-dark" => (
            "#282c34", "#abb2bf", "#528bff", "#3e4451",
            vec![
                "#282c34", "#e06c75", "#98c379", "#e5c07b",
                "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
                "#545862", "#e06c75", "#98c379", "#e5c07b",
                "#61afef", "#c678dd", "#56b6c2", "#c8ccd4",
            ],
        ),
        "catppuccin-mocha" => (
            "#1e1e2e", "#cdd6f4", "#f5e0dc", "#585b70",
            vec![
                "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
                "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
                "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
                "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
            ],
        ),
        _ => return, // unknown preset — keep user-specified colors
    };

    // Only override fields that are still at their default values.
    if theme.background == default_background() { theme.background = bg.to_string(); }
    if theme.foreground == default_foreground() { theme.foreground = fg.to_string(); }
    if theme.cursor == default_cursor_color() { theme.cursor = cursor.to_string(); }
    if theme.selection_bg == default_selection_bg() { theme.selection_bg = sel.to_string(); }
    if theme.ansi == default_ansi() { theme.ansi = ansi.into_iter().map(|s| s.to_string()).collect(); }
}

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

use std::sync::OnceLock;
static CONFIG_PATH_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// Set a custom config file path (from `--config` CLI argument).
pub fn set_config_path(path: PathBuf) {
    let _ = CONFIG_PATH_OVERRIDE.set(path);
}

fn config_path() -> Option<PathBuf> {
    if let Some(p) = CONFIG_PATH_OVERRIDE.get() {
        return Some(p.clone());
    }
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
            Ok(mut config) => {
                log::info!("Loaded config from {}", path.display());
                apply_theme_preset(&mut config.theme);
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

// ---------------------------------------------------------------------------
// Config hot-reload (mtime polling)
// ---------------------------------------------------------------------------

/// Start a background thread that polls the config file for changes.
/// When the file is modified, emits a "config-changed" event with the new config.
pub fn start_config_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last_mtime: Option<std::time::SystemTime> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let path = match config_path() {
                Some(p) => p,
                None => continue,
            };
            let mtime = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());
            if mtime != last_mtime && last_mtime.is_some() {
                // File changed — reload and emit
                let cfg = load_config();
                let _ = app.emit("config-changed", cfg);
                log::info!("Config reloaded from {}", path.display());
            }
            last_mtime = mtime;
        }
    });
}
