mod config;
mod db;
mod explorer;
mod fs;
mod gamepad;
mod input;
mod markdown;
mod menus;
mod mouse;
mod pane_tree;
mod prompt_panel;
mod prompts;
mod terminal;
mod terminal_pane;
mod terminal_view;
mod text_field;
mod workspace;
mod workspace_view;

use gpui::{prelude::*, px, size, App, Application, Bounds, WindowBounds, WindowOptions};
fn main() {
    config::init_logging();
    Application::new().run(|cx: &mut App| {
        menus::install(cx);
        let bounds = Bounds::centered(None, size(px(1280.), px(820.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(640.), px(420.))),
                    window_background: gpui::WindowBackgroundAppearance::Transparent,
                    ..Default::default()
                },
                |_, cx| cx.new(workspace_view::WorkspaceView::new),
            )
            .expect("failed to open window");
        window
            .update(cx, |_, window, cx| {
                let root = cx.weak_entity();
                window.on_window_should_close(cx, move |_, cx| {
                    let _ = root.update(cx, |root, cx| root.prepare_close(cx));
                    true
                });
            })
            .unwrap();
        if std::env::args().any(|a| a == "--smoke-test") {
            window
                .update(cx, |view, _, cx| view.start_smoke(cx))
                .unwrap();
        }
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
