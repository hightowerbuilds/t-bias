use crate::terminal_view::SharedMetrics;
use crate::{config::Config, gamepad};
use alacritty_terminal::{
    grid::Dimensions,
    index::{Column, Point as TermPoint, Side},
    selection::{Selection, SelectionType},
    term::{viewport_to_point, TermMode},
};
use gpui::{
    ClipboardItem, EntityInputHandler, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    Pixels, Point, UTF16Selection,
};
use gpui_kit::component::Disableable;
use std::time::Duration;
use std::{cell::Cell, ops::Range, rc::Rc};

use crate::fs::EntryKind;
use alacritty_terminal::event::Event as AlacEvent;
use alacritty_terminal::grid::Scroll;
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, relative, rgb, AnyElement, Bounds, Context, FocusHandle, KeyDownEvent,
    ScrollDelta, ScrollWheelEvent, Window,
};

use crate::explorer::{is_markdown, Explorer, Preview};
use crate::gamepad::{PadAction, PadEvent, Stick};
use crate::input::{encode_key, KeyMods};
use crate::markdown::markdown_element;
use crate::terminal::{Terminal, TerminalSize};
use crate::terminal_view::{terminal_element, Theme};

/// Flip animation: total duration and step count (frames).
const FLIP_STEPS: u32 = 14;
const FLIP_STEP_MS: u64 = 16;

/// Initial grid size until the element measures real cell dimensions.
const INITIAL_SIZE: TerminalSize = TerminalSize {
    cols: 100,
    lines: 30,
    pixel_width: 0,
    pixel_height: 0,
};

/// Scrollback lines per gamepad tick at full stick deflection. The pad thread
/// ticks at 125 Hz, so this works out to ~40 lines/second held hard over.
const PAD_SCROLL_LINES_PER_TICK: f32 = 0.32;

/// Which face of the pane is showing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Face {
    Terminal,
    Explorer,
}

/// An in-progress flip: `t` runs 0→1; the face swaps at the midpoint.
struct Flip {
    to: Face,
    t: f32,
}

pub struct TerminalPane {
    pub terminal: Option<Terminal>,
    pub exited: bool,
    pub title: String,
    pub config: Config,
    pub font_size: f32,
    pub focus_requested: bool,
    explorer: Explorer,
    explorer_index: usize,
    markdown_skin: crate::markdown::Skin,
    face: Face,
    flip: Option<Flip>,
    pub focus: FocusHandle,
    geometry: SharedMetrics,
    selecting: bool,
    mouse_button: Option<MouseButton>,
    mouse_last: Option<(usize, usize)>,
    scroll_fraction: f32,
    preedit: String,
    preedit_selection: Range<usize>,
    cursor_visible: bool,
    /// Name of the connected controller, if any (shown in the toolbar).
    pad: Option<String>,
    /// Fractional scrollback carried between analog-stick ticks.
    pad_scroll: f32,
}

impl TerminalPane {
    pub fn new(cwd: Option<&std::path::Path>, config: Config, cx: &mut Context<Self>) -> Self {
        let terminal = match Terminal::new(INITIAL_SIZE, cwd) {
            Ok((terminal, mut events)) => {
                // Drain terminal events on the GPUI foreground; each Wakeup means
                // new grid content, so coalesce a burst then repaint once.
                cx.spawn(async move |this, cx| {
                    while let Some(first) = events.next().await {
                        let mut batch = vec![first];
                        while batch.len() < 128 {
                            match events.try_recv() {
                                Ok(ev) => batch.push(ev),
                                Err(_) => break,
                            }
                        }
                        let exited = batch.iter().any(is_exit);
                        let alive = this
                            .update(cx, |pane, cx| {
                                for event in batch {
                                    pane.on_terminal_event(event, cx);
                                }
                                cx.notify();
                            })
                            .is_ok();
                        if !alive || exited {
                            break;
                        }
                    }
                })
                .detach();

                Some(terminal)
            }
            Err(err) => {
                log::error!("failed to start terminal: {err:#}");
                None
            }
        };

        cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(550))
                .await;
            if this
                .update(cx, |pane, cx| {
                    pane.cursor_visible = !pane.cursor_visible;
                    if pane.config.cursor_blink {
                        cx.notify();
                    }
                })
                .is_err()
            {
                break;
            }
        })
        .detach();
        Self {
            terminal,
            exited: false,
            title: "Shell".into(),
            font_size: config.font_size,
            config,
            focus_requested: false,
            explorer: Explorer::new(),
            explorer_index: 0,
            markdown_skin: crate::markdown::Skin::Default,
            face: Face::Terminal,
            flip: None,
            focus: cx.focus_handle(),
            geometry: Rc::new(Cell::new(None)),
            selecting: false,
            mouse_button: None,
            mouse_last: None,
            scroll_fraction: 0.,
            preedit: String::new(),
            preedit_selection: 0..0,
            cursor_visible: true,
            pad: None,
            pad_scroll: 0.0,
        }
    }

    /// Apply a controller event. Button verbs go through `input::encode_key`, so
    /// the pad inherits the tested control-code / application-cursor behavior
    /// rather than carrying a second copy of it.
    pub fn on_pad(&mut self, event: PadEvent, cx: &mut Context<Self>) {
        match event {
            PadEvent::Connected(name) => {
                log::info!("controller connected: {name}");
                self.pad = Some(name);
                cx.notify();
            }
            PadEvent::Disconnected(name) => {
                log::info!("controller disconnected: {name}");
                self.pad = None;
                self.pad_scroll = 0.0;
                cx.notify();
            }
            PadEvent::Pressed(button) => {
                // The profile resolver translates file actions to these controls.
                if self.face != Face::Terminal {
                    let key = match button {
                        gamepad::PsButton::Up => "up",
                        gamepad::PsButton::Down => "down",
                        gamepad::PsButton::Cross => "enter",
                        gamepad::PsButton::Square => "backspace",
                        gamepad::PsButton::Circle => "escape",
                        _ => return,
                    };
                    self.explorer_key(key, cx);
                    return;
                }
                let Some(action) = gamepad::binding(button) else {
                    return;
                };
                let Some(term) = self.terminal.as_ref() else {
                    return;
                };
                let handle = term.handle();
                match action {
                    PadAction::Key { key, mods } => {
                        if let Some(bytes) = encode_key(key, None, mods, handle.app_cursor()) {
                            handle.scroll_to_bottom();
                            handle.input(bytes);
                            cx.notify();
                        }
                    }
                    PadAction::Scroll(lines) => {
                        handle.scroll(Scroll::Delta(lines));
                        cx.notify();
                    }
                }
            }
            PadEvent::Released(_) => {}
            // Right stick scrolls the scrollback, proportional to deflection so
            // a nudge creeps and a full push flies.
            PadEvent::Stick {
                stick: Stick::Right,
                y,
                ..
            } => {
                if self.face != Face::Terminal || y.abs() < gamepad::DEAD_ZONE_EXIT {
                    return;
                }
                let Some(term) = self.terminal.as_ref() else {
                    return;
                };
                self.pad_scroll += y * PAD_SCROLL_LINES_PER_TICK;
                let lines = self.pad_scroll.trunc();
                if lines != 0.0 {
                    self.pad_scroll -= lines;
                    term.handle().scroll(Scroll::Delta(lines as i32));
                    cx.notify();
                }
            }
            // The left stick belongs to text entry (Phase 3).
            PadEvent::Stick { .. } => {}
        }
    }

    /// Start flipping to the other face (ignored if a flip is in progress).
    fn toggle_flip(&mut self, cx: &mut Context<Self>) {
        if self.flip.is_some() {
            return;
        }
        let to = match self.face {
            Face::Terminal => Face::Explorer,
            Face::Explorer => Face::Terminal,
        };
        if to == Face::Explorer {
            // Follow the terminal: re-root at the repo the shell is currently in.
            match self.terminal.as_ref().and_then(|t| t.cwd()) {
                Some(cwd) => self.explorer.follow(&cwd),
                None => self.explorer.refresh(),
            }
        }
        self.flip = Some(Flip { to, t: 0.0 });

        // Drive the animation off a timer, swapping the live face at the midpoint.
        cx.spawn(async move |this, cx| {
            for i in 1..=FLIP_STEPS {
                cx.background_executor()
                    .timer(Duration::from_millis(FLIP_STEP_MS))
                    .await;
                let t = i as f32 / FLIP_STEPS as f32;
                let alive = this
                    .update(cx, |root, cx| {
                        if let Some(flip) = root.flip.as_mut() {
                            flip.t = t;
                            if t >= 0.5 {
                                root.face = flip.to;
                            }
                        }
                        cx.notify();
                    })
                    .is_ok();
                if !alive {
                    return;
                }
            }
            let _ = this.update(cx, |root, cx| {
                root.flip = None;
                cx.notify();
            });
        })
        .detach();
    }

    /// Encode a keystroke and send it to the shell (or handle ⌘ shortcuts).
    fn on_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        let m = ks.modifiers;

        if let Some(action) = self.config.action(ks).map(str::to_string) {
            if self.perform(&action, cx) {
                cx.stop_propagation();
            }
            return;
        }
        if self.face != Face::Terminal {
            self.explorer_key(&ks.key, cx);
            return;
        }
        let Some(term) = self.terminal.as_ref() else {
            return;
        };
        let handle = term.handle();
        if m.platform {
            return;
        }
        // Printable text belongs to the platform input handler, including IME.
        if !m.control
            && !(m.alt && self.config.option_as_meta)
            && (ks.key == "space"
                || ks
                    .key_char
                    .as_ref()
                    .is_some_and(|s| !s.is_empty() && s.chars().all(|c| !c.is_control())))
        {
            return;
        }
        if !self.preedit.is_empty() {
            return;
        }
        let mods = KeyMods {
            ctrl: m.control,
            alt: m.alt,
            shift: m.shift,
            cmd: m.platform,
        };
        if let Some(bytes) = encode_key(&ks.key, ks.key_char.as_deref(), mods, handle.app_cursor())
        {
            handle.clear_selection();
            handle.scroll_to_bottom();
            handle.input(bytes);
            cx.stop_propagation();
            cx.notify();
        }
    }

    /// Scroll the scrollback viewport (terminal face only).
    fn on_scroll(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        if self.face != Face::Terminal {
            return;
        }
        let Some(term) = self.terminal.as_ref() else {
            return;
        };
        let line_h = self.font_size * self.config.line_height;
        let delta = match event.delta {
            ScrollDelta::Lines(p) => p.y,
            ScrollDelta::Pixels(p) => f32::from(p.y) / line_h,
        };
        self.scroll_fraction += delta;
        let lines = self.scroll_fraction.trunc() as i32;
        self.scroll_fraction -= lines as f32;
        if lines == 0 {
            return;
        }
        let mode = term.handle().mode();
        if mode.intersects(TermMode::MOUSE_MODE) && !event.modifiers.shift {
            for _ in 0..lines.unsigned_abs().min(100) {
                self.send_mouse(
                    event.position,
                    if lines > 0 { 64 } else { 65 },
                    false,
                    event.modifiers,
                );
            }
        } else {
            term.handle().scroll(Scroll::Delta(lines));
        }
        cx.stop_propagation();
        cx.notify();
    }

    /// Build the read-only explorer face — a markdown preview if one is open,
    /// otherwise the directory listing.
    fn render_explorer(&self, cx: &mut Context<Self>) -> AnyElement {
        if let Some(preview) = self.explorer.preview() {
            return self.render_preview(preview, cx);
        }
        let at_root = self.explorer.at_root();
        let up = crate::ui::button("explorer-up", "↑")
            .tooltip("Parent directory")
            .disabled(at_root)
            .on_click(cx.listener(|this, _, _, cx| {
                this.explorer.up();
                cx.notify();
            }));

        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .px_2()
            .py_1()
            .bg(Theme::from_config(&self.config).chrome())
            .text_color(Theme::from_config(&self.config).muted())
            .child(up)
            .child(self.explorer.display_path());

        let mut list = div()
            .id("explorer-list")
            .flex_1()
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .py_1();

        if let Some(err) = self.explorer.error() {
            list = list.child(
                div()
                    .px_2()
                    .text_color(rgb(0xff7b72))
                    .child(format!("cannot read directory: {err}")),
            );
        }
        for (i, entry) in self.explorer.entries().iter().enumerate() {
            let (label, color) = match entry.kind {
                EntryKind::Directory => (format!("{}/", entry.name), rgb(0x58a6ff)),
                EntryKind::Symlink => (format!("{}@", entry.name), rgb(0x39c5cf)),
                EntryKind::File => (entry.name.clone(), Theme::from_config(&self.config).fg),
            };
            // Markdown files are clickable too (→ preview); mark them 📝.
            let md = entry.kind == EntryKind::File && is_markdown(&entry.name);
            let label = if md { format!("{label} ·md") } else { label };
            let mut row = div()
                .id(("entry", i))
                .when(i == self.explorer_index, |el| el.bg(rgb(0x26384c)))
                .px_2()
                .text_color(color)
                .hover(|s| s.bg(rgb(0x1f2630)))
                .child(label);
            if entry.kind == EntryKind::Directory {
                let name = entry.name.clone();
                row = row.on_click(cx.listener(move |this, _, _, cx| {
                    this.explorer.enter(&name);
                    cx.notify();
                }));
            } else if md {
                let name = entry.name.clone();
                row = row.on_click(cx.listener(move |this, _, _, cx| {
                    this.explorer.open_file(&name);
                    cx.notify();
                }));
            }
            list = list.child(row);
        }

        div()
            .flex()
            .flex_col()
            .size_full()
            .font_family(self.config.font_family.clone())
            .text_size(px(self.font_size))
            .child(header)
            .child(list)
            .into_any_element()
    }

    /// Build the markdown preview face (toolbar + rendered document).
    fn render_preview(&self, preview: &Preview, cx: &mut Context<Self>) -> AnyElement {
        let button = crate::ui::button;

        let toolbar = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .px_2()
            .py_1()
            .bg(Theme::from_config(&self.config).chrome())
            .font_family(self.config.font_family.clone())
            .text_size(px(13.))
            .text_color(Theme::from_config(&self.config).muted())
            .child(
                button("md-back", "← files").on_click(cx.listener(|this, _, _, cx| {
                    this.explorer.close_preview();
                    cx.notify();
                })),
            )
            .child(
                div()
                    .text_color(Theme::from_config(&self.config).fg)
                    .child(preview.name.clone()),
            )
            .child(div().flex_1())
            .child(
                button("md-skin", self.markdown_skin.label()).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.markdown_skin = this.markdown_skin.next();
                        cx.notify();
                    },
                )),
            )
            .child(
                button("md-fdown", "A−").on_click(cx.listener(|this, _, _, cx| {
                    this.explorer.zoom_preview(-1.0);
                    cx.notify();
                })),
            )
            .child(
                button("md-freset", "reset").on_click(cx.listener(|this, _, _, cx| {
                    this.explorer.reset_preview_font();
                    cx.notify();
                })),
            )
            .child(
                button("md-fup", "A+").on_click(cx.listener(|this, _, _, cx| {
                    this.explorer.zoom_preview(1.0);
                    cx.notify();
                })),
            );

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(toolbar)
            .child(markdown_element(
                &preview.blocks,
                self.explorer.preview_font(),
                self.markdown_skin,
            ))
            .into_any_element()
    }
}

/// Whether a terminal event means the shell is gone.
fn is_exit(event: &AlacEvent) -> bool {
    matches!(event, AlacEvent::Exit | AlacEvent::ChildExit(_))
}

impl Render for TerminalPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Grab keyboard focus on first paint so typing works immediately.
        if self.focus_requested {
            self.focus_requested = false;
            window.focus(&self.focus, cx);
        }
        let focused = self.focus.is_focused(window);
        let flipping = self.flip.is_some();
        // Horizontal squish: full at t=0/1, edge-on at t=0.5.
        let scale = self
            .flip
            .as_ref()
            .map(|f| (1.0 - 2.0 * f.t).abs().max(0.02))
            .unwrap_or(1.0);

        // The current face's content (the animation swaps `self.face` at t=0.5).
        let face_el: AnyElement = match self.face {
            Face::Terminal => match &self.terminal {
                Some(term) => terminal_element(
                    term.handle(),
                    self.config.font_family.clone().into(),
                    px(self.font_size),
                    Theme::from_config(&self.config),
                    focused,
                    flipping,
                    self.config.line_height,
                    self.geometry.clone(),
                    cx.entity(),
                    self.cursor_visible || !self.config.cursor_blink,
                )
                .into_any_element(),
                None => div()
                    .font_family(self.config.font_family.clone())
                    .text_color(rgb(0xff7b72))
                    .child("failed to start terminal — see logs")
                    .into_any_element(),
            },
            Face::Explorer => self.render_explorer(cx),
        };

        // Toolbar: the flip button (also ⌘E).
        let flip_label = match self.face {
            Face::Terminal => "⇋  files  (⌘E)",
            Face::Explorer => "⇋  terminal  (⌘E)",
        };
        // Controller state, so it's obvious at a glance whether the pad is live
        // (a DualShock 4 sleeps on its own and reconnects silently).
        let (pad_label, pad_color) = match &self.pad {
            Some(name) => (format!("◉ {name}"), rgb(0x3fb950)),
            None => ("○ no controller".to_string(), rgb(0x484f58)),
        };

        let toolbar = div()
            .flex()
            .flex_none()
            .justify_end()
            .items_center()
            .px_2()
            .py_1()
            .child(
                div()
                    .font_family(self.config.font_family.clone())
                    .text_size(px(12.))
                    .text_color(pad_color)
                    .child(pad_label),
            )
            .child(div().flex_1())
            .child(
                crate::ui::button("flip-btn", flip_label)
                    .tooltip("Files / Terminal · ⌘E")
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_flip(cx))),
            );

        // The pane, squished horizontally during a flip.
        let pane = div()
            .flex_1()
            .flex()
            .justify_center()
            .overflow_hidden()
            // Breathing room from the window edges for every face.
            .px(px(self.config.padding))
            .pb_2()
            .child(
                div()
                    .h_full()
                    .w(relative(scale))
                    .when(self.face == Face::Terminal, |el| {
                        el.on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
                            .on_mouse_down(MouseButton::Right, cx.listener(Self::mouse_down))
                            .on_mouse_down(MouseButton::Middle, cx.listener(Self::mouse_down))
                            .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
                            .on_mouse_up(MouseButton::Right, cx.listener(Self::mouse_up))
                            .on_mouse_up(MouseButton::Middle, cx.listener(Self::mouse_up))
                            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::mouse_up))
                            .on_mouse_move(cx.listener(Self::mouse_move))
                    })
                    .child(face_el),
            );

        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| this.on_key(ev, cx)))
            .on_scroll_wheel(
                cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| this.on_scroll(ev, cx)),
            )
            .flex()
            .flex_col()
            .size_full()
            .bg(Theme::from_config(&self.config).bg)
            .child(toolbar)
            .child(pane)
            .when(!self.preedit.is_empty(), |el| {
                el.child(
                    div()
                        .px_3()
                        .text_color(rgb(0x58a6ff))
                        .child(self.preedit.clone()),
                )
            })
    }
}

impl TerminalPane {
    fn on_terminal_event(&mut self, event: AlacEvent, cx: &mut Context<Self>) {
        let Some(term) = &self.terminal else {
            return;
        };
        let handle = term.handle();
        match event {
            AlacEvent::PtyWrite(text) => handle.input(text.into_bytes()),
            AlacEvent::Title(title) => self.title = title,
            AlacEvent::ResetTitle => self.title = "Shell".into(),
            AlacEvent::Exit | AlacEvent::ChildExit(_) => self.exited = true,
            AlacEvent::ColorRequest(index, reply) => {
                let color = { handle.term().lock().colors()[index] };
                handle.input(
                    reply(
                        color
                            .unwrap_or_else(|| Theme::from_config(&self.config).query_color(index)),
                    )
                    .into_bytes(),
                );
            }
            AlacEvent::TextAreaSizeRequest(reply) => {
                let t = handle.term().lock();
                let metrics = self.geometry.get();
                handle.input(
                    reply(alacritty_terminal::event::WindowSize {
                        num_lines: t.screen_lines() as u16,
                        num_cols: t.columns() as u16,
                        cell_width: metrics.map(|m| f32::from(m.cell_w) as u16).unwrap_or(0),
                        cell_height: metrics.map(|m| f32::from(m.line_h) as u16).unwrap_or(0),
                    })
                    .into_bytes(),
                );
            }
            AlacEvent::Bell => {
                self.cursor_visible = true;
                cx.notify();
            }
            _ => {}
        }
    }
    pub fn perform(&mut self, action: &str, cx: &mut Context<Self>) -> bool {
        match action {
            "flip" => self.toggle_flip(cx),
            "copy" => {
                if let Some(text) = self
                    .terminal
                    .as_ref()
                    .and_then(|t| t.handle().selection_text())
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }
            "paste" => {
                if self.face == Face::Terminal {
                    if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                        self.paste(&text, cx);
                    }
                }
            }
            "font_increase" => self.font_size = (self.font_size + 1.).min(40.),
            "font_decrease" => self.font_size = (self.font_size - 1.).max(8.),
            "font_reset" => self.font_size = self.config.font_size,
            _ => return false,
        }
        cx.notify();
        true
    }
    pub fn show_terminal(&mut self, cx: &mut Context<Self>) {
        self.face = Face::Terminal;
        self.flip = None;
        cx.notify();
    }
    pub fn show_explorer(&mut self, cx: &mut Context<Self>) {
        if self.face != Face::Explorer {
            self.restore_explorer();
        }
        self.flip = None;
        cx.notify();
    }
    pub fn paste(&mut self, text: &str, cx: &mut Context<Self>) {
        if let Some(term) = &self.terminal {
            let h = term.handle();
            h.clear_selection();
            h.scroll_to_bottom();
            h.paste(text);
        }
        cx.notify();
    }
    pub fn is_explorer(&self) -> bool {
        self.face == Face::Explorer
    }
    pub fn restore_explorer(&mut self) {
        if let Some(cwd) = self.terminal.as_ref().and_then(|t| t.cwd()) {
            self.explorer.follow(&cwd);
        }
        self.face = Face::Explorer;
    }
    fn explorer_key(&mut self, key: &str, cx: &mut Context<Self>) {
        match key {
            "escape" => {
                if self.explorer.preview().is_some() {
                    self.explorer.close_preview();
                } else {
                    self.toggle_flip(cx);
                }
            }
            "backspace" => {
                self.explorer.up();
                self.explorer_index = 0;
            }
            "up" => self.explorer_index = self.explorer_index.saturating_sub(1),
            "down" => {
                self.explorer_index =
                    (self.explorer_index + 1).min(self.explorer.entries().len().saturating_sub(1))
            }
            "enter" => {
                if let Some(entry) = self.explorer.entries().get(self.explorer_index).cloned() {
                    match entry.kind {
                        EntryKind::Directory => {
                            self.explorer.enter(&entry.name);
                            self.explorer_index = 0;
                        }
                        EntryKind::File => self.explorer.open_file(&entry.name),
                        _ => {}
                    }
                }
            }
            "-" => self.explorer.zoom_preview(-1.),
            "=" | "+" => self.explorer.zoom_preview(1.),
            "s" => self.markdown_skin = self.markdown_skin.next(),
            _ => return,
        }
        cx.notify();
    }
    fn cell_at(&self, position: Point<Pixels>) -> Option<(usize, usize, Side)> {
        let m = self.geometry.get()?;
        let term = self.terminal.as_ref()?.handle();
        let t = term.term().lock();
        let x = f32::from(position.x - m.bounds.origin.x) / f32::from(m.cell_w);
        let y = f32::from(position.y - m.bounds.origin.y) / f32::from(m.line_h);
        Some((
            (x.floor().max(0.) as usize).min(t.columns() - 1),
            (y.floor().max(0.) as usize).min(t.screen_lines() - 1),
            if x.fract() < 0.5 {
                Side::Left
            } else {
                Side::Right
            },
        ))
    }
    fn send_mouse(&self, pos: Point<Pixels>, button: u8, released: bool, mods: gpui::Modifiers) {
        let Some((col, row, _)) = self.cell_at(pos) else {
            return;
        };
        let Some(term) = &self.terminal else {
            return;
        };
        if let Some(bytes) = crate::mouse::report(
            term.handle().mode(),
            button,
            col,
            row,
            released,
            KeyMods {
                ctrl: mods.control,
                alt: mods.alt,
                shift: mods.shift,
                cmd: mods.platform,
            },
        ) {
            term.handle().input(bytes);
        }
    }
    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.mouse_last = None;
        self.mouse_button = Some(event.button);
        let Some((col, row, side)) = self.cell_at(event.position) else {
            return;
        };
        let Some(terminal) = &self.terminal else {
            return;
        };
        let h = terminal.handle();
        if h.mode().intersects(TermMode::MOUSE_MODE) && !event.modifiers.shift {
            self.send_mouse(
                event.position,
                button_code(event.button),
                false,
                event.modifiers,
            );
        } else if event.button == MouseButton::Left {
            let mut t = h.term().lock();
            let point =
                viewport_to_point(t.grid().display_offset(), TermPoint::new(row, Column(col)));
            if event.modifiers.shift && t.selection.is_some() {
                t.selection.as_mut().unwrap().update(point, side);
            } else {
                t.selection = Some(Selection::new(
                    match event.click_count {
                        2 => SelectionType::Semantic,
                        3.. => SelectionType::Lines,
                        _ if event.modifiers.alt => SelectionType::Block,
                        _ => SelectionType::Simple,
                    },
                    point,
                    side,
                ));
            }
            self.selecting = true;
        }
        cx.notify();
    }
    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some((col, row, side)) = self.cell_at(event.position) else {
            return;
        };
        let Some(terminal) = &self.terminal else {
            return;
        };
        let h = terminal.handle();
        let mode = h.mode();
        if !event.modifiers.shift
            && (mode.contains(TermMode::MOUSE_MOTION)
                || mode.contains(TermMode::MOUSE_DRAG) && event.pressed_button.is_some())
        {
            if self.mouse_last != Some((col, row)) {
                self.send_mouse(
                    event.position,
                    event.pressed_button.map(button_code).unwrap_or(3) + 32,
                    false,
                    event.modifiers,
                );
                self.mouse_last = Some((col, row));
            }
        } else if self.selecting && event.dragging() {
            let mut t = h.term().lock();
            let point =
                viewport_to_point(t.grid().display_offset(), TermPoint::new(row, Column(col)));
            if let Some(s) = &mut t.selection {
                s.update(point, side);
            }
            cx.notify();
        }
    }
    fn mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.mouse_button.take() != Some(event.button) {
            return;
        }
        self.selecting = false;
        if self
            .terminal
            .as_ref()
            .is_some_and(|t| t.handle().mode().intersects(TermMode::MOUSE_MODE))
            && !event.modifiers.shift
        {
            self.send_mouse(
                event.position,
                button_code(event.button),
                true,
                event.modifiers,
            );
        }
        cx.notify();
    }
}
fn button_code(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        _ => 3,
    }
}

impl EntityInputHandler for TerminalPane {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let utf16: Vec<u16> = self.preedit.encode_utf16().collect();
        let range = range.start.min(utf16.len())..range.end.min(utf16.len());
        *actual = Some(range.clone());
        String::from_utf16(&utf16[range]).ok()
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        (self.face == Face::Terminal).then(|| UTF16Selection {
            range: self.preedit_selection.clone(),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.preedit.is_empty()).then(|| 0..self.preedit.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.preedit.clear();
        self.preedit_selection = 0..0;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.face != Face::Terminal {
            return;
        }
        self.preedit.clear();
        self.preedit_selection = 0..0;
        if let Some(t) = &self.terminal {
            let h = t.handle();
            h.clear_selection();
            h.scroll_to_bottom();
            h.input(text.as_bytes().to_vec());
        }
        self.cursor_visible = true;
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut utf16: Vec<u16> = self.preedit.encode_utf16().collect();
        let range = range.unwrap_or(0..utf16.len());
        let start = range.start.min(utf16.len());
        let end = range.end.min(utf16.len()).max(start);
        utf16.splice(start..end, text.encode_utf16());
        self.preedit = String::from_utf16_lossy(&utf16);
        let len = text.encode_utf16().count();
        let selected = selected.unwrap_or(len..len);
        self.preedit_selection =
            (start + selected.start).min(utf16.len())..(start + selected.end).min(utf16.len());
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let m = self.geometry.get()?;
        let h = self.terminal.as_ref()?.handle();
        let t = h.term().lock();
        let p = t.grid().cursor.point;
        Some(Bounds::new(
            gpui::point(
                m.bounds.origin.x + p.column.0 * m.cell_w,
                m.bounds.origin.y + p.line.0.max(0) as usize * m.line_h,
            ),
            gpui::size(m.cell_w, m.line_h),
        ))
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.preedit_selection.end)
    }
}

impl TerminalPane {
    pub fn smoke_enter(&mut self, cx: &mut Context<Self>) {
        let mut keystroke = gpui::Keystroke::parse("enter").unwrap();
        keystroke.key_char = Some("\r".into());
        self.on_key(
            &KeyDownEvent {
                keystroke,
                is_held: false,
                prefer_character_input: false,
            },
            cx,
        );
    }
}

impl TerminalPane {
    pub fn smoke_copy(&mut self, marker: &str, cx: &mut Context<Self>) {
        let h = self.terminal.as_ref().unwrap().handle();
        {
            let mut t = h.term().lock();
            let points: Vec<_> = t
                .grid()
                .display_iter()
                .map(|c| (c.point, c.cell.c))
                .collect();
            let chars: Vec<_> = marker.chars().collect();
            let range = points
                .windows(chars.len())
                .find(|w| w.iter().map(|(_, c)| *c).eq(chars.iter().copied()))
                .expect("selection marker missing");
            let mut selection = Selection::new(SelectionType::Simple, range[0].0, Side::Left);
            selection.update(range.last().unwrap().0, Side::Right);
            t.selection = Some(selection);
        }
        let previous = cx.read_from_clipboard();
        self.perform("copy", cx);
        assert_eq!(
            cx.read_from_clipboard().and_then(|c| c.text()).as_deref(),
            Some(marker)
        );
        if let Some(item) = previous {
            cx.write_to_clipboard(item);
        }
    }
    pub fn smoke_markdown(&mut self, cx: &mut Context<Self>) {
        self.explorer.follow(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap(),
        );
        self.explorer.open_file("README.md");
        assert!(self
            .explorer
            .preview()
            .is_some_and(|p| !p.blocks.is_empty()));
        self.face = Face::Explorer;
        cx.notify();
    }
}
