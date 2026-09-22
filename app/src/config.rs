//! User configuration. Invalid files report an error instead of being overwritten.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub controller: crate::controller::profile::Profile,
    pub activity_monitor: ActivityMonitorConfig,
    pub theme: String,
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub padding: f32,
    pub opacity: f32,
    pub cursor_blink: bool,
    pub option_as_meta: bool,
    pub keybindings: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ActivityMonitorConfig {
    pub refresh_seconds: u64,
}
impl Default for ActivityMonitorConfig {
    fn default() -> Self {
        Self { refresh_seconds: 2 }
    }
}
impl Default for Config {
    fn default() -> Self {
        Self {
            controller: Default::default(),
            activity_monitor: ActivityMonitorConfig::default(),
            theme: "dark".into(),
            font_family: "Menlo".into(),
            font_size: 14.,
            line_height: 1.3,
            padding: 12.,
            opacity: 1.,
            cursor_blink: true,
            option_as_meta: false,
            keybindings: [
                ("new_tab", "cmd-t"),
                ("close_pane", "cmd-w"),
                ("split_horizontal", "cmd-d"),
                ("split_vertical", "cmd-shift-d"),
                ("zoom", "cmd-enter"),
                ("previous_tab", "cmd-["),
                ("next_tab", "cmd-]"),
                ("pane_left", "cmd-alt-left"),
                ("pane_right", "cmd-alt-right"),
                ("pane_up", "cmd-alt-up"),
                ("pane_down", "cmd-alt-down"),
                ("flip", "cmd-e"),
                ("copy", "cmd-c"),
                ("paste", "cmd-v"),
                ("font_increase", "cmd-="),
                ("font_decrease", "cmd--"),
                ("font_reset", "cmd-0"),
                ("prompts", "cmd-shift-p"),
                ("send_next_prompt", "cmd-shift-q"),
                ("settings", "cmd-,"),
                ("activity_monitor", "cmd-shift-a"),
            ]
            .into_iter()
            .map(|(a, b)| (a.into(), b.into()))
            .collect(),
        }
    }
}
pub fn data_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("TBIAS_DATA_DIR") {
        return Ok(path.into());
    }
    Ok(
        PathBuf::from(std::env::var_os("HOME").context("HOME not set")?)
            .join("Library/Application Support/com.tbias.app"),
    )
}
pub fn path() -> Result<PathBuf> {
    Ok(std::env::var_os("TBIAS_CONFIG")
        .map(PathBuf::from)
        .unwrap_or(data_dir()?.join("config.toml")))
}
impl Config {
    pub fn load() -> Result<Self> {
        let path = path()?;
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, toml::to_string_pretty(&Self::default())?)?;
        }
        Self::parse(&std::fs::read_to_string(&path)?)
            .with_context(|| format!("configuration {}", path.display()))
    }
    pub fn parse(text: &str) -> Result<Self> {
        let mut config: Self = toml::from_str(text)?;
        config.controller.validate()?;
        if ![1, 2, 5].contains(&config.activity_monitor.refresh_seconds) {
            bail!("activity_monitor.refresh_seconds must be 1, 2, or 5");
        }
        if !["dark", "light", "dracula"].contains(&config.theme.as_str()) {
            bail!("theme must be dark, light, or dracula");
        }
        if config.font_family.trim().is_empty()
            || !config.font_size.is_finite()
            || !(8. ..=40.).contains(&config.font_size)
            || !config.line_height.is_finite()
            || !(1. ..=2.5).contains(&config.line_height)
            || !config.padding.is_finite()
            || !(0. ..=64.).contains(&config.padding)
            || !config.opacity.is_finite()
            || !(0.2..=1.).contains(&config.opacity)
        {
            bail!("invalid font, line height, padding, or opacity");
        }
        let defaults = Self::default().keybindings;
        for (action, key) in &config.keybindings {
            if !defaults.contains_key(action) {
                bail!("unknown action: {action}");
            }
            gpui::Keystroke::parse(key)
                .with_context(|| format!("invalid shortcut for {action}"))?;
        }
        for (action, key) in defaults {
            config.keybindings.entry(action).or_insert(key);
        }
        Ok(config)
    }
    pub fn action(&self, key: &gpui::Keystroke) -> Option<&str> {
        self.keybindings.iter().find_map(|(action, chord)| {
            let expected = gpui::Keystroke::parse(chord).ok()?;
            (expected.key == key.key && expected.modifiers == key.modifiers)
                .then_some(action.as_str())
        })
    }
}
static LOG_FILE: std::sync::OnceLock<std::sync::Mutex<std::fs::File>> = std::sync::OnceLock::new();
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            let line = format!("[{}] {}", r.level(), r.args());
            eprintln!("{line}");
            if let Some(file) = LOG_FILE.get() {
                use std::io::Write;
                if let Ok(mut file) = file.lock() {
                    let _ = writeln!(file, "{line}");
                }
            }
        }
    }
    fn flush(&self) {}
}
pub fn init_logging() {
    if let Ok(dir) = data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("startup.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 5 * 1024 * 1024) {
            let _ = std::fs::rename(&path, dir.join("startup.previous.log"));
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = LOG_FILE.set(std::sync::Mutex::new(file));
        }
    }
    static LOGGER: Logger = Logger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_config_keeps_shortcuts() {
        let c = Config::parse("theme = 'light'\n[keybindings]\nnew_tab = 'cmd-n'").unwrap();
        assert_eq!(c.keybindings["new_tab"], "cmd-n");
        assert_eq!(c.keybindings["copy"], "cmd-c");
        assert_eq!(c.keybindings["activity_monitor"], "cmd-shift-a");
        assert_eq!(c.activity_monitor.refresh_seconds, 2);
    }
    #[test]
    fn rejects_invalid_values() {
        for text in [
            "font_size = nan",
            "opacity = 0.0",
            "theme = 'missing'",
            "line_height = -1.0",
            "[activity_monitor]\nrefresh_seconds = 0",
            "[activity_monitor]\nrefresh_seconds = 3",
        ] {
            assert!(Config::parse(text).is_err());
        }
    }
}

/// Save only settings owned by the settings view, preserving controller profiles
/// and untouched values/comments. Optimistic conflict detection precedes atomic
/// replacement; runtime settings are intentionally not modified here.
pub fn save_settings(path: &std::path::Path, baseline: &str, draft: &Config) -> Result<String> {
    use std::io::Write;
    let current = std::fs::read_to_string(path)?;
    if current != baseline {
        bail!("Configuration changed outside this editor. Reload saved before applying.");
    }
    let before =
        Config::parse(&current).context("Existing configuration is invalid; original preserved")?;
    let serialized = toml::to_string(draft)?;
    Config::parse(&serialized)?;
    let mut doc = current.parse::<toml_edit::DocumentMut>()?;
    let proposed = serialized.parse::<toml_edit::DocumentMut>()?;
    let old = toml::to_string(&before)?.parse::<toml_edit::DocumentMut>()?;
    fn update(target: &mut toml_edit::Item, value: &toml_edit::Item) {
        let decor = target.as_value().map(|v| v.decor().clone());
        *target = value.clone();
        if let (Some(decor), Some(value)) = (decor, target.as_value_mut()) {
            *value.decor_mut() = decor;
        }
    }
    for key in [
        "theme",
        "font_family",
        "font_size",
        "line_height",
        "padding",
        "opacity",
        "cursor_blink",
        "option_as_meta",
    ] {
        if old[key].to_string() != proposed[key].to_string() {
            update(&mut doc[key], &proposed[key]);
        }
    }
    if before.activity_monitor.refresh_seconds != draft.activity_monitor.refresh_seconds {
        update(
            &mut doc["activity_monitor"]["refresh_seconds"],
            &proposed["activity_monitor"]["refresh_seconds"],
        );
    }
    for (key, value) in &draft.keybindings {
        if before.keybindings.get(key) != Some(value) {
            update(&mut doc["keybindings"][key], &proposed["keybindings"][key]);
        }
    }
    let text = doc.to_string();
    Config::parse(&text)?;
    let temp = path.with_extension(format!(
        "settings-{}-{}.tmp",
        std::process::id(),
        crate::workspace_view::now()
    ));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.set_permissions(std::fs::metadata(path)?.permissions())?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        if std::fs::read_to_string(path)? != baseline {
            bail!("Configuration changed during save. Reload saved before applying.");
        }
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    Ok(text)
}

#[cfg(test)]
mod settings_tests {
    use super::*;
    #[test]
    fn settings_save_preserves_profiles_and_comments_and_rejects_conflicts() {
        let path = std::env::temp_dir().join(format!("tbias-settings-{}.toml", std::process::id()));
        let mut profile = crate::controller::profile::Profile::default();
        profile.set(
            crate::controller::profile::Surface::Terminal,
            crate::gamepad::PsButton::Circle,
            crate::controller::profile::Action::Enter,
        );
        let baseline = format!(
            "# personal settings\ntheme = 'dark' # appearance\n\n[controller]\n{}",
            toml::to_string(&profile)
                .unwrap()
                .replace("version = 1", "version = 1 # keep")
                .replace("[bindings", "[controller.bindings")
        );
        let baseline = baseline.as_str();
        std::fs::write(&path, baseline).unwrap();
        let mut draft = Config::parse(baseline).unwrap();
        draft.theme = "dracula".into();
        draft.activity_monitor.refresh_seconds = 5;
        draft.keybindings.insert("new_tab".into(), "cmd-n".into());
        let saved = save_settings(&path, baseline, &draft).unwrap();
        assert!(saved.contains("# appearance"));
        assert!(saved.contains("version = 1 # keep"));
        let parsed = Config::parse(&saved).unwrap();
        assert_eq!(parsed.theme, "dracula");
        assert_eq!(parsed.activity_monitor.refresh_seconds, 5);
        assert_eq!(parsed.keybindings["new_tab"], "cmd-n");
        assert_eq!(parsed.controller, draft.controller);
        assert!(save_settings(&path, baseline, &draft).is_err());
        draft.opacity = f32::NAN;
        assert!(save_settings(&path, &saved, &draft).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        std::fs::write(&path, "invalid = [").unwrap();
        assert!(save_settings(&path, "invalid = [", &Config::default()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid = [");
        std::fs::remove_file(path).unwrap();
    }
}
