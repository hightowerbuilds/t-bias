// t-bias — native GPUI shell.
//
// A single live terminal: `Root` owns a `Terminal` backend (PTY +
// alacritty_terminal), drains its event channel on a GPUI task, repaints on each
// Wakeup, and forwards keyboard/scroll/paste input to the shell. The grid is
// drawn by the Phase 2 cell element (`terminal_view`).

mod db;
mod input;
mod pane_tree;
mod terminal;
mod terminal_view;

use alacritty_terminal::event::Event as AlacEvent;
use alacritty_terminal::grid::Scroll;
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, FocusHandle, KeyDownEvent, ScrollDelta,
    ScrollWheelEvent, Window, WindowBounds, WindowOptions,
};

use input::{encode_key, KeyMods};
use terminal::{Terminal, TerminalSize};
use terminal_view::{terminal_element, Theme};

const FONT_FAMILY: &str = "Menlo";
const FONT_SIZE: f32 = 14.;
const LINE_HEIGHT: f32 = 1.3;

/// Initial grid size until the element measures real cell dimensions.
const INITIAL_SIZE: TerminalSize = TerminalSize {
    cols: 100,
    lines: 30,
};

struct Root {
    terminal: Option<Terminal>,
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
            focus: cx.focus_handle(),
            focused_once: false,
        }
    }

    /// Encode a keystroke and send it to the shell (or handle ⌘ shortcuts).
    fn on_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let Some(term) = self.terminal.as_ref() else {
            return;
        };
        let handle = term.handle();
        let ks = &event.keystroke;
        let m = ks.modifiers;

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

    /// Scroll the scrollback viewport.
    fn on_scroll(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
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
}

/// Whether a terminal event means the shell is gone.
fn is_exit(event: &AlacEvent) -> bool {
    matches!(event, AlacEvent::Exit | AlacEvent::ChildExit(_))
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Grab keyboard focus on first paint so typing works immediately.
        if !self.focused_once {
            window.focus(&self.focus, cx);
            self.focused_once = true;
        }
        let focused = self.focus.is_focused(window);

        let root = div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| this.on_key(ev, cx)))
            .on_scroll_wheel(
                cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| this.on_scroll(ev, cx)),
            )
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x0d1117))
            .p_2();

        match &self.terminal {
            Some(term) => root.child(div().flex_1().child(terminal_element(
                term.handle(),
                FONT_FAMILY.into(),
                px(FONT_SIZE),
                Theme::default(),
                focused,
            ))),
            None => root.text_color(rgb(0xff7b72)).child(
                div()
                    .font_family(FONT_FAMILY)
                    .child("failed to start terminal — see logs"),
            ),
        }
    }
}

fn main() {
    gpui_platform::application().run(|cx: &mut App| {
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
