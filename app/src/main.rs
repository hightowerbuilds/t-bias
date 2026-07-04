// t-bias — native GPUI shell.
//
// A single live terminal: `Root` owns a `Terminal` backend (PTY +
// alacritty_terminal), drains its event channel on a GPUI task, repaints on each
// Wakeup, and forwards keyboard/scroll/paste input to the shell. The grid is
// drawn by the Phase 2 cell element (`terminal_view`).

mod db;
mod explorer;
mod fs;
mod input;
mod markdown;
mod pane_tree;
mod terminal;
mod terminal_view;
mod workspace;

use std::time::Duration;

use alacritty_terminal::event::Event as AlacEvent;
use alacritty_terminal::grid::Scroll;
use fs::EntryKind;
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, relative, rgb, size, AnyElement, App, Application, Bounds, Context,
    FocusHandle, KeyDownEvent, ScrollDelta, ScrollWheelEvent, Window, WindowBounds, WindowOptions,
};

use explorer::{is_markdown, Explorer, Preview};
use input::{encode_key, KeyMods};
use markdown::markdown_element;
use terminal::{Terminal, TerminalSize};
use terminal_view::{terminal_element, Theme};

const FONT_FAMILY: &str = "Menlo";
const FONT_SIZE: f32 = 14.;
const LINE_HEIGHT: f32 = 1.3;

/// Flip animation: total duration and step count (frames).
const FLIP_STEPS: u32 = 14;
const FLIP_STEP_MS: u64 = 16;

/// Initial grid size until the element measures real cell dimensions.
const INITIAL_SIZE: TerminalSize = TerminalSize {
    cols: 100,
    lines: 30,
};

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

struct Root {
    terminal: Option<Terminal>,
    explorer: Explorer,
    face: Face,
    flip: Option<Flip>,
    focus: FocusHandle,
    focused_once: bool,
}

impl Root {
    fn new(cx: &mut Context<Self>) -> Self {
        let terminal = match Terminal::new(INITIAL_SIZE) {
            Ok((terminal, mut events)) => {
                // Drain terminal events on the GPUI foreground; each Wakeup means
                // new grid content, so coalesce a burst then repaint once.
                cx.spawn(async move |this, cx| {
                    while let Some(first) = events.next().await {
                        let mut exited = is_exit(&first);
                        while let Ok(ev) = events.try_recv() {
                            if is_exit(&ev) {
                                exited = true;
                            }
                        }
                        // New content (or shell exit) → repaint. Exit handling
                        // (mark pane dead, collapse) lands with the Phase 4 UI.
                        let alive = this.update(cx, |_, cx| cx.notify()).is_ok();
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

        Self {
            terminal,
            explorer: Explorer::new(),
            face: Face::Terminal,
            flip: None,
            focus: cx.focus_handle(),
            focused_once: false,
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

        // ⌘E flips the pane regardless of which face is showing.
        if m.platform && ks.key == "e" {
            self.toggle_flip(cx);
            return;
        }
        // The explorer is browsed with the mouse; no PTY input while it shows.
        if self.face != Face::Terminal {
            return;
        }
        let Some(term) = self.terminal.as_ref() else {
            return;
        };
        let handle = term.handle();

        // ⌘ shortcuts: paste (copy needs a selection — Phase 3b).
        if m.platform {
            if ks.key == "v" {
                if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                    handle.scroll_to_bottom();
                    handle.paste(&text);
                    cx.notify();
                }
            }
            return;
        }

        let mods = KeyMods {
            ctrl: m.control,
            alt: m.alt,
            shift: m.shift,
            cmd: m.platform,
        };
        if let Some(bytes) = encode_key(&ks.key, ks.key_char.as_deref(), mods, handle.app_cursor()) {
            handle.scroll_to_bottom();
            handle.input(bytes);
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
        let line_h = FONT_SIZE * LINE_HEIGHT;
        let lines = match event.delta {
            ScrollDelta::Lines(p) => p.y as i32,
            ScrollDelta::Pixels(p) => (f32::from(p.y) / line_h) as i32,
        };
        if lines != 0 {
            term.handle().scroll(Scroll::Delta(lines));
            cx.notify();
        }
    }

    /// Build the read-only explorer face — a markdown preview if one is open,
    /// otherwise the directory listing.
    fn render_explorer(&self, cx: &mut Context<Self>) -> AnyElement {
        if let Some(preview) = self.explorer.preview() {
            return self.render_preview(preview, cx);
        }
        let at_root = self.explorer.at_root();
        let up = div()
            .id("explorer-up")
            .px_2()
            .rounded_md()
            .text_color(if at_root { rgb(0x484f58) } else { rgb(0x58a6ff) })
            .when(!at_root, |el| el.hover(|s| s.bg(rgb(0x21262d))))
            .child("..")
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
            .bg(rgb(0x161b22))
            .text_color(rgb(0x8b949e))
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
                EntryKind::File => (entry.name.clone(), rgb(0xe6edf3)),
            };
            // Markdown files are clickable too (→ preview); mark them 📝.
            let md = entry.kind == EntryKind::File && is_markdown(&entry.name);
            let label = if md { format!("{label} ·md") } else { label };
            let mut row = div()
                .id(("entry", i))
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
            .font_family(FONT_FAMILY)
            .text_size(px(FONT_SIZE))
            .child(header)
            .child(list)
            .into_any_element()
    }

    /// Build the markdown preview face (toolbar + rendered document).
    fn render_preview(&self, preview: &Preview, cx: &mut Context<Self>) -> AnyElement {
        let button = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .px_2()
                .rounded_md()
                .bg(rgb(0x21262d))
                .text_color(rgb(0xc9d1d9))
                .hover(|s| s.bg(rgb(0x30363d)))
                .child(label)
        };

        let toolbar = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .px_2()
            .py_1()
            .bg(rgb(0x161b22))
            .font_family(FONT_FAMILY)
            .text_size(px(13.))
            .text_color(rgb(0x8b949e))
            .child(button("md-back", "← files").on_click(cx.listener(|this, _, _, cx| {
                this.explorer.close_preview();
                cx.notify();
            })))
            .child(div().text_color(rgb(0xe6edf3)).child(preview.name.clone()))
            .child(div().flex_1())
            .child(button("md-fdown", "A−").on_click(cx.listener(|this, _, _, cx| {
                this.explorer.zoom_preview(-1.0);
                cx.notify();
            })))
            .child(button("md-freset", "reset").on_click(cx.listener(|this, _, _, cx| {
                this.explorer.reset_preview_font();
                cx.notify();
            })))
            .child(button("md-fup", "A+").on_click(cx.listener(|this, _, _, cx| {
                this.explorer.zoom_preview(1.0);
                cx.notify();
            })));

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(toolbar)
            .child(markdown_element(&preview.blocks, self.explorer.preview_font()))
            .into_any_element()
    }
}

/// Whether a terminal event means the shell is gone.
fn is_exit(event: &AlacEvent) -> bool {
    matches!(event, AlacEvent::Exit | AlacEvent::ChildExit(_))
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Grab keyboard focus on first paint so typing works immediately.
        if !self.focused_once {
            window.focus(&self.focus);
            self.focused_once = true;
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
                    FONT_FAMILY.into(),
                    px(FONT_SIZE),
                    Theme::default(),
                    focused,
                    flipping,
                )
                .into_any_element(),
                None => div()
                    .font_family(FONT_FAMILY)
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
        let toolbar = div()
            .flex()
            .flex_none()
            .justify_end()
            .items_center()
            .px_2()
            .py_1()
            .child(
                div()
                    .id("flip-btn")
                    .px_2()
                    .rounded_md()
                    .bg(rgb(0x21262d))
                    .text_color(rgb(0xc9d1d9))
                    .font_family(FONT_FAMILY)
                    .text_size(px(12.))
                    .hover(|s| s.bg(rgb(0x30363d)))
                    .child(flip_label)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_flip(cx))),
            );

        // The pane, squished horizontally during a flip.
        let pane = div()
            .flex_1()
            .flex()
            .justify_center()
            .overflow_hidden()
            .child(div().h_full().w(relative(scale)).child(face_el));

        div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| this.on_key(ev, cx)))
            .on_scroll_wheel(
                cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| this.on_scroll(ev, cx)),
            )
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x0d1117))
            .child(toolbar)
            .child(pane)
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.), px(820.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_window, cx| cx.new(Root::new),
        )
        .expect("failed to open window");
        cx.activate(true);
    });
}
