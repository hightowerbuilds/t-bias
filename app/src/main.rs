// t-bias — native GPUI shell (Phase 0: hello window).
//
// The PTY spine (alacritty_terminal + portable-pty) lands in Phase 1. For now
// this just proves the toolchain: a real native window opens and renders text.

use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, SharedString, Window, WindowBounds,
    WindowOptions,
};

struct Root {
    title: SharedString,
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .bg(rgb(0x0d1117))
            .text_color(rgb(0xe6edf3))
            .child(div().text_2xl().child(self.title.clone()))
            .child(
                div()
                    .text_color(rgb(0x8b949e))
                    .child("native GPUI window — Phase 0 ✓"),
            )
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
            |_window, cx| {
                cx.new(|_cx| Root {
                    title: "t-bias".into(),
                })
            },
        )
        .expect("failed to open window");
        cx.activate(true);
    });
}
