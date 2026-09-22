//! Draft-only settings. Apply persists; terminal/runtime settings change on restart.
use crate::{
    config::{self, Config},
    ui::button,
};
use gpui::{div, prelude::*, Context, Entity, EventEmitter, FocusHandle, Subscription, Window};
use gpui_kit::component::{
    input::{Input, InputState},
    switch::Switch,
    ActiveTheme, Selectable,
};
use std::collections::BTreeMap;

pub enum SettingsEvent {
    Close,
}
pub struct Settings {
    baseline: String,
    draft: Config,
    fields: BTreeMap<&'static str, Entity<InputState>>,
    shortcuts: BTreeMap<String, Entity<InputState>>,
    _fields: Vec<Subscription>,
    message: Option<String>,
    load_requested: bool,
    focus: FocusHandle,
    focus_requested: bool,
}
impl EventEmitter<SettingsEvent> for Settings {}
const FIELDS: [(&str, &str); 5] = [
    ("font_family", "Terminal font"),
    ("font_size", "Font size (8–40)"),
    ("line_height", "Line height (1–2.5)"),
    ("padding", "Padding (0–64)"),
    ("opacity", "Opacity (0.2–1)"),
];
impl Settings {
    pub fn new(config: &Config, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let fields: BTreeMap<_, _> = FIELDS
            .into_iter()
            .map(|(id, _)| (id, cx.new(|cx| InputState::new(window, cx))))
            .collect();
        let shortcuts: BTreeMap<_, _> = config
            .keybindings
            .keys()
            .map(|id| (id.clone(), cx.new(|cx| InputState::new(window, cx))))
            .collect();
        let events = fields
            .values()
            .chain(shortcuts.values())
            .map(|field| cx.observe(field, |_, _, cx| cx.notify()))
            .collect();
        Self {
            baseline: String::new(),
            draft: config.clone(),
            fields,
            shortcuts,
            _fields: events,
            message: None,
            load_requested: true,
            focus: cx.focus_handle(),
            focus_requested: false,
        }
    }
    pub fn open(&mut self, cx: &mut Context<Self>) {
        self.focus_requested = true;
        cx.notify();
    }
    fn populate(&mut self, config: Config, window: &mut Window, cx: &mut Context<Self>) {
        for (id, text) in [
            ("font_family", config.font_family.clone()),
            ("font_size", config.font_size.to_string()),
            ("line_height", config.line_height.to_string()),
            ("padding", config.padding.to_string()),
            ("opacity", config.opacity.to_string()),
        ] {
            self.fields[id].update(cx, |s, cx| s.set_value(text, window, cx));
        }
        for (id, field) in &self.shortcuts {
            field.update(cx, |s, cx| {
                s.set_value(config.keybindings[id].clone(), window, cx)
            });
        }
        self.draft = config;
        cx.notify();
    }
    fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let result = config::path()
            .and_then(|path| Ok(std::fs::read_to_string(path)?))
            .and_then(|text| Ok((Config::parse(&text)?, text)));
        match result {
            Ok((config, text)) => {
                self.baseline = text;
                self.populate(config, window, cx);
                self.message = None;
            }
            Err(e) => {
                self.message = Some(format!(
                    "Cannot load settings; original file preserved: {e:#}"
                ))
            }
        }
        cx.notify();
    }
    fn edited(&self, cx: &gpui::App) -> anyhow::Result<Config> {
        let mut draft = self.draft.clone();
        draft.font_family = self.fields["font_family"].read(cx).value().to_string();
        for (name, value) in [
            ("font_size", &mut draft.font_size),
            ("line_height", &mut draft.line_height),
            ("padding", &mut draft.padding),
            ("opacity", &mut draft.opacity),
        ] {
            *value = self.fields[name]
                .read(cx)
                .value()
                .parse()
                .map_err(|_| anyhow::anyhow!("{name} must be a number"))?;
        }
        for (name, field) in &self.shortcuts {
            draft
                .keybindings
                .insert(name.clone(), field.read(cx).value().to_string());
        }
        Config::parse(&toml::to_string(&draft)?)
    }
    fn apply(&mut self, cx: &mut Context<Self>) {
        let result = self.edited(cx).and_then(|draft| {
            config::path()
                .and_then(|path| config::save_settings(&path, &self.baseline, &draft))
                .map(|text| (draft, text))
        });
        match result {
            Ok((draft, text)) => {
                self.draft = draft;
                self.baseline = text;
                self.message = Some("Saved. Restart t-bias to apply these settings.".into());
            }
            Err(e) => self.message = Some(format!("Not saved: {e:#}")),
        }
        cx.notify();
    }
    fn discard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Ok(config) = Config::parse(&self.baseline) {
            self.populate(config, window, cx);
            self.message = None;
        }
    }
}
impl Render for Settings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.load_requested {
            self.load_requested = false;
            self.reload(window, cx);
        }
        if self.focus_requested {
            self.focus_requested = false;
            window.focus(&self.focus, cx);
        }
        let mut content = div().flex().flex_col().gap_4();
        let mut themes = div().flex().gap_2();
        for name in ["dark", "light", "dracula"] {
            themes = themes.child(
                button(name, name)
                    .selected(self.draft.theme == name)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.draft.theme = name.into();
                        cx.notify();
                    })),
            );
        }
        content = content.child(div().child("Appearance")).child(themes);
        for (id, label) in FIELDS {
            content = content.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(label)
                    .child(Input::new(&self.fields[id]).aria_label(label)),
            );
        }
        content = content
            .child(
                Switch::new("cursor-blink")
                    .label("Blink terminal cursor")
                    .checked(self.draft.cursor_blink)
                    .on_change(cx.listener(|this, value, _, cx| {
                        this.draft.cursor_blink = *value;
                        cx.notify();
                    })),
            )
            .child(
                Switch::new("option-meta")
                    .label("Use Option as terminal Meta")
                    .checked(self.draft.option_as_meta)
                    .on_change(cx.listener(|this, value, _, cx| {
                        this.draft.option_as_meta = *value;
                        cx.notify();
                    })),
            )
            .child(
                button(
                    "refresh",
                    format!(
                        "Activity refresh: {} seconds",
                        self.draft.activity_monitor.refresh_seconds
                    ),
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.draft.activity_monitor.refresh_seconds =
                        match this.draft.activity_monitor.refresh_seconds {
                            1 => 2,
                            2 => 5,
                            _ => 1,
                        };
                    cx.notify();
                })),
            )
            .child(div().text_lg().child("Keyboard shortcuts"));
        for (action, field) in &self.shortcuts {
            let label = action.replace('_', " ");
            content = content.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(label.clone())
                    .child(Input::new(field).aria_label(label)),
            );
        }
        div().size_full().flex().flex_col().gap_3().p_4().bg(cx.theme().background).text_color(cx.theme().foreground)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, _, cx| { if e.keystroke.key == "escape" { cx.emit(SettingsEvent::Close); cx.stop_propagation(); } else if e.keystroke.modifiers.platform && e.keystroke.key == "s" { this.apply(cx); cx.stop_propagation(); } }))
            .child(div().text_xl().child("Settings"))
            .child(div().text_sm().child("Changes take effect after restarting t-bias. Drafts stay here until Apply or Discard."))
            .when_some(self.message.clone(), |d, message| d.child(div().child(message)))
            .child(div().id("settings-scroll").flex_1().min_h_0().overflow_y_scroll().child(content))
            .child(div().flex().flex_wrap().gap_2()
                .child(button("settings-apply", "Apply").on_click(cx.listener(|this, _, _, cx| this.apply(cx))))
                .child(button("settings-discard", "Discard").on_click(cx.listener(|this, _, window, cx| this.discard(window, cx))))
                .child(button("settings-reload", "Reload saved").on_click(cx.listener(|this, _, window, cx| this.reload(window, cx))))
                .child(button("settings-file", "Open configuration").on_click(|_, _, cx| { if let Ok(path) = config::path() { cx.open_with_system(&path); } }))
                .child(button("settings-close", "Close").on_click(cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Close)))))
    }
}

impl Settings {
    pub fn kit_smoke(&mut self, phase: usize, window: &mut Window, cx: &mut Context<Self>) {
        match phase {
            0 => {
                self.fields["font_size"].update(cx, |s, cx| s.set_value("20", window, cx));
                self.discard(window, cx);
                assert_eq!(self.fields["font_size"].read(cx).value(), "14");
                self.fields["font_size"].update(cx, |s, cx| s.set_value("18", window, cx));
                self.apply(cx);
                assert_eq!(Config::load().unwrap().font_size, 18.);
            }
            1 => {
                self.fields["opacity"].update(cx, |s, cx| s.set_value("0", window, cx));
                self.apply(cx);
                assert!(self.message.as_ref().unwrap().starts_with("Not saved"));
                assert_eq!(Config::load().unwrap().opacity, 1.);
                self.discard(window, cx);
            }
            2 => {
                let path = config::path().unwrap();
                std::fs::write(&path, format!("{}\n# external edit\n", self.baseline)).unwrap();
                self.draft.theme = "light".into();
                self.apply(cx);
                assert!(self.message.as_ref().unwrap().contains("changed outside"));
                assert_eq!(Config::load().unwrap().theme, "dark");
                self.reload(window, cx);
            }
            _ => {}
        }
    }
}
