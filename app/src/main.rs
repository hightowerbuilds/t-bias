// t-bias — native GPUI shell.
//
// Phase 1: a single live terminal. `Root` owns a `Terminal` backend (PTY +
// alacritty_terminal), drains its event channel on a GPUI task, and repaints on
// each Wakeup. Rendering is still a naive per-line text dump — the real
// cell-grid `TerminalElement` (colors, attrs, cursor) lands in Phase 2.

mod terminal;

use std::time::Duration;

use alacritty_terminal::event::Event as AlacEvent;
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, Window, WindowBounds, WindowOptions,
};

use terminal::{Terminal, TerminalSize};

/// Initial grid size until the element measures real cell dimensions (Phase 2).
const INITIAL_SIZE: TerminalSize = TerminalSize {
    cols: 100,
    lines: 30,
};

struct Root {
    terminal: Option<Terminal>,
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
                        // Coalesce everything already queued into this repaint.
                        while let Ok(ev) = events.try_recv() {
                            if is_exit(&ev) {
                                exited = true;
                            }
                        }
                        let alive = this
                            .update(cx, |root, cx| {
                                if exited {
                                    if let Some(t) = root.terminal.as_mut() {
                                        t.mark_exited();
                                    }
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

                // Phase-1 scaffolding: with no keyboard input yet (Phase 3), drive
                // a couple of commands after startup so each launch visibly streams
                // live PTY output. Remove once real input lands.
                cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(500))
                        .await;
                    let _ = this.update(cx, |root, _| {
                        if let Some(t) = root.terminal.as_ref() {
                            t.input("echo \"t-bias phase 1: PTY + alacritty_terminal live\"\r");
                        }
                    });
                    cx.background_executor()
                        .timer(Duration::from_millis(300))
                        .await;
                    let _ = this.update(cx, |root, _| {
                        if let Some(t) = root.terminal.as_ref() {
                            t.input("uname -a && ls -1 | head -n 8\r");
                        }
                    });
                })
                .detach();

                Some(terminal)
            }
            Err(err) => {
                log::error!("failed to start terminal: {err:#}");
                None
            }
        };

        Self { terminal }
    }
}

/// Whether a terminal event means the shell is gone.
fn is_exit(event: &AlacEvent) -> bool {
    matches!(event, AlacEvent::Exit | AlacEvent::ChildExit(_))
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let mut column = div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x0d1117))
            .text_color(rgb(0xe6edf3))
            .text_size(px(14.))
            .font_family("Menlo")
            .p_3()
            .gap(px(0.));

        match &self.terminal {
            Some(term) => {
                for line in term.visible_lines() {
                    // A per-line div preserves row breaks; a non-breaking space
                    // keeps empty rows from collapsing to zero height.
                    let text = if line.is_empty() {
                        "\u{00a0}".to_string()
                    } else {
                        line
                    };
                    column = column.child(div().child(text));
                }
                if term.has_exited() {
                    column = column
                        .child(div().text_color(rgb(0x8b949e)).child("[shell exited]"));
                }
            }
            None => {
                column = column.child(
                    div()
                        .text_color(rgb(0xff7b72))
                        .child("failed to start terminal — see logs"),
                );
            }
        }

        column
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
