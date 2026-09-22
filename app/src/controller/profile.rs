//! Typed button actions, shared by labels, preview, persistence and dispatch.
use crate::gamepad::{PadEvent, PsButton};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    #[default]
    Terminal,
    Files,
    Learn,
    Computer,
}
impl Surface {
    pub const ALL: [Self; 4] = [Self::Terminal, Self::Files, Self::Learn, Self::Computer];
    pub fn label(self) -> &'static str {
        match self {
            Self::Terminal => "Terminal",
            Self::Files => "Files",
            Self::Learn => "Learn",
            Self::Computer => "Computer",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    None,
    Enter,
    Interrupt,
    Complete,
    Space,
    Up,
    Down,
    Left,
    Right,
    HistoryUp,
    HistoryDown,
    ScrollUp,
    ScrollDown,
    Open,
    Parent,
    Back,
    PreviousLesson,
    NextLesson,
    Descend,
    Ascend,
    Reset,
    PreviousStation,
    NextStation,
    Lesson,
}
impl Action {
    pub fn label(self) -> &'static str {
        use Action::*;
        match self {
            None => "Unassigned",
            Enter => "Submit / Enter",
            Interrupt => "Interrupt / Ctrl-C",
            Complete => "Complete / Tab",
            Space => "Insert space",
            Up => "Up",
            Down => "Down",
            Left => "Left",
            Right => "Right",
            HistoryUp => "Previous command",
            HistoryDown => "Next command",
            ScrollUp => "Scroll back",
            ScrollDown => "Scroll forward",
            Open => "Open selected file",
            Parent => "Parent directory",
            Back => "Back",
            PreviousLesson => "Previous lesson",
            NextLesson => "Next lesson",
            Descend => "Descend (hold)",
            Ascend => "Ascend (hold)",
            Reset => "Reset camera",
            PreviousStation => "Previous station",
            NextStation => "Next station",
            Lesson => "Read station lesson",
        }
    }
    pub fn choices(surface: Surface) -> &'static [Self] {
        use Action::*;
        match surface {
            Surface::Terminal => &[
                None,
                Enter,
                Interrupt,
                Complete,
                Space,
                Up,
                Down,
                Left,
                Right,
                HistoryUp,
                HistoryDown,
                ScrollUp,
                ScrollDown,
            ],
            Surface::Files => &[None, Up, Down, Open, Parent, Back],
            Surface::Learn => &[None, Back, PreviousLesson, NextLesson],
            Surface::Computer => &[
                None,
                Back,
                Reset,
                Descend,
                Ascend,
                PreviousStation,
                NextStation,
                Lesson,
            ],
        }
    }
    // Existing surface handlers remain the execution boundary. Only these typed
    // actions can become terminal bytes; profiles never contain scripts/macros.
    pub fn button(self, surface: Surface) -> Option<PsButton> {
        use Action::*;
        use PsButton as B;
        if !Self::choices(surface).contains(&self) {
            return Option::None;
        }
        Some(match self {
            None => return Option::None,
            Enter => B::Triangle,
            Interrupt | Back => B::Circle,
            Complete => B::Square,
            Space | Open | Lesson => B::Cross,
            Up => B::Up,
            Down => B::Down,
            Left | PreviousLesson | PreviousStation => B::Left,
            Right | NextLesson | NextStation => B::Right,
            HistoryUp | Descend => B::L1,
            HistoryDown | Ascend => B::R1,
            ScrollUp => B::L2,
            ScrollDown => B::R2,
            Parent => B::Square,
            Reset => B::Triangle,
        })
    }
}
pub fn default_action(surface: Surface, button: PsButton) -> Action {
    use Action::*;
    use PsButton as B;
    match surface {
        Surface::Terminal => match button {
            B::Triangle => Enter,
            B::Circle => Interrupt,
            B::Cross => Space,
            B::Square => Complete,
            B::Up => Up,
            B::Down => Down,
            B::Left => Left,
            B::Right => Right,
            B::L1 => HistoryUp,
            B::R1 => HistoryDown,
            B::L2 => ScrollUp,
            B::R2 => ScrollDown,
            _ => None,
        },
        Surface::Files => match button {
            B::Up => Up,
            B::Down => Down,
            B::Cross => Open,
            B::Square => Parent,
            B::Circle => Back,
            _ => None,
        },
        Surface::Learn => match button {
            B::Circle => Back,
            B::Left => PreviousLesson,
            B::Right => NextLesson,
            _ => None,
        },
        Surface::Computer => match button {
            B::Circle => Back,
            B::Triangle => Reset,
            B::L1 => Descend,
            B::R1 => Ascend,
            B::Left => PreviousStation,
            B::Right => NextStation,
            B::Cross => Lesson,
            _ => None,
        },
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Profile {
    pub version: u32,
    pub bindings: BTreeMap<Surface, BTreeMap<PsButton, Action>>,
}
impl Default for Profile {
    fn default() -> Self {
        Self {
            version: 1,
            bindings: BTreeMap::new(),
        }
    }
}
impl Profile {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            bail!("Unsupported controller profile version {}", self.version);
        }
        for (surface, bindings) in &self.bindings {
            for action in bindings.values() {
                if !Action::choices(*surface).contains(action) {
                    bail!("{} is not valid for {}", action.label(), surface.label());
                }
            }
        }
        Ok(())
    }
    pub fn action(&self, s: Surface, b: PsButton) -> Action {
        self.bindings
            .get(&s)
            .and_then(|m| m.get(&b))
            .copied()
            .unwrap_or_else(|| default_action(s, b))
    }
    pub fn set(&mut self, s: Surface, b: PsButton, a: Action) {
        if a == default_action(s, b) {
            if let Some(m) = self.bindings.get_mut(&s) {
                m.remove(&b);
                if m.is_empty() {
                    self.bindings.remove(&s);
                }
            }
        } else {
            self.bindings.entry(s).or_default().insert(b, a);
        }
    }
    pub fn resolve(&self, s: Surface, event: PadEvent) -> Option<PadEvent> {
        match event {
            PadEvent::Pressed(b) => self.action(s, b).button(s).map(PadEvent::Pressed),
            PadEvent::Released(b) => self.action(s, b).button(s).map(PadEvent::Released),
            other => Some(other),
        }
    }
}
/// Optimistic external-edit check, same-directory atomic replacement, original
/// preserved on validation/write failure. Returns the new baseline for Apply.
pub fn save(path: &Path, baseline: &str, profile: &Profile) -> Result<String> {
    use std::io::Write;
    profile.validate()?;
    let current = std::fs::read_to_string(path)?;
    if current != baseline {
        bail!("Configuration changed outside this editor. Use Reload saved before applying.");
    }
    crate::config::Config::parse(&current)
        .context("Existing configuration is invalid; original preserved")?;
    let mut config = current.parse::<toml_edit::DocumentMut>()?;
    let table = toml::to_string_pretty(profile)?.parse::<toml_edit::DocumentMut>()?;
    config["controller"] = toml_edit::Item::Table(table.as_table().clone());
    let text = config.to_string();
    crate::config::Config::parse(&text)?;
    let temp = path.with_extension(format!(
        "controller-{}-{}.tmp",
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
mod tests {
    use super::*;
    #[test]
    fn defaults_preserve_terminal_and_world_actions() {
        let p = Profile::default();
        for b in PsButton::ALL {
            if crate::gamepad::binding(b).is_some() {
                assert_eq!(
                    p.resolve(Surface::Terminal, PadEvent::Pressed(b)),
                    Some(PadEvent::Pressed(b))
                );
            }
        }
        for b in [
            PsButton::Circle,
            PsButton::Triangle,
            PsButton::L1,
            PsButton::R1,
            PsButton::Left,
            PsButton::Right,
            PsButton::Cross,
        ] {
            assert_eq!(
                p.resolve(Surface::Computer, PadEvent::Pressed(b)),
                Some(PadEvent::Pressed(b))
            );
        }
    }
    #[test]
    fn remap_is_contextual_and_release_matches_press() {
        let mut p = Profile::default();
        p.set(Surface::Terminal, PsButton::Circle, Action::Enter);
        assert_eq!(
            p.resolve(Surface::Terminal, PadEvent::Pressed(PsButton::Circle)),
            Some(PadEvent::Pressed(PsButton::Triangle))
        );
        assert_eq!(
            p.resolve(Surface::Terminal, PadEvent::Released(PsButton::Circle)),
            Some(PadEvent::Released(PsButton::Triangle))
        );
        assert_eq!(p.action(Surface::Computer, PsButton::Circle), Action::Back);
        p.set(Surface::Terminal, PsButton::Circle, Action::Interrupt);
        assert_eq!(p, Profile::default());
    }
    #[test]
    fn save_preserves_settings_and_rejects_conflicts_and_bad_profiles() {
        let path =
            std::env::temp_dir().join(format!("tbias-controller-{}.toml", std::process::id()));
        let baseline = "# config\ntheme = 'light'\nfont_size = 18\n";
        std::fs::write(&path, baseline).unwrap();
        let mut p = Profile::default();
        p.set(Surface::Learn, PsButton::Cross, Action::NextLesson);
        let saved = save(&path, baseline, &p).unwrap();
        assert!(
            saved.starts_with(baseline),
            "unrelated formatting/comments changed"
        );
        let c = crate::config::Config::parse(&saved).unwrap();
        assert_eq!(c.theme, "light");
        assert_eq!(c.font_size, 18.);
        assert_eq!(c.controller, p);
        assert!(save(&path, baseline, &p).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        p.version = 2;
        assert!(save(&path, &saved, &p).is_err());
        p.version = 1;
        p.set(Surface::Learn, PsButton::Cross, Action::Interrupt);
        assert!(p.validate().is_err());
        for invalid in ["[controller]\nversion = 2\n", "invalid = ["] {
            std::fs::write(&path, invalid).unwrap();
            assert!(save(&path, invalid, &Profile::default()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
        }
        std::fs::remove_file(path).unwrap();
    }
}
