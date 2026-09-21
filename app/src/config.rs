//! User configuration. Invalid files report an error instead of being overwritten.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
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
impl Default for Config {
    fn default() -> Self {
        Self {
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
    }
    #[test]
    fn rejects_invalid_values() {
        for text in [
            "font_size = nan",
            "opacity = 0.0",
            "theme = 'missing'",
            "line_height = -1.0",
        ] {
            assert!(Config::parse(text).is_err());
        }
    }
}
