mod activity;
mod config;
mod controller;
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
mod settings;
mod terminal;
mod terminal_pane;
mod terminal_view;
mod ui;
mod workspace;
mod workspace_view;

use gpui::{prelude::*, px, size, App, Bounds, WindowBounds, WindowOptions};
fn main() {
    if std::env::args().any(|a| a == "--check-data") {
        verify_existing_data().expect("copied-data continuity");
        return;
    }
    if let Some(path) = std::env::args()
        .skip_while(|a| a != "--controller-probe")
        .nth(1)
    {
        if let Err(e) = controller::renderer::probe(&path) {
            eprintln!("Controller probe: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|a| a == "--activity-probe") {
        activity::collector::probe();
        return;
    }
    config::init_logging();
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(|cx: &mut App| {
            gpui_kit::init(cx);
            menus::install(cx);
            let initial_size = if std::env::args().any(|a| a == "--compact") {
                size(px(640.), px(420.))
            } else {
                size(px(1280.), px(820.))
            };
            let bounds = Bounds::centered(None, initial_size, cx);
            let _window = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        window_min_size: Some(size(px(640.), px(420.))),
                        window_background: gpui::WindowBackgroundAppearance::Transparent,
                        ..Default::default()
                    },
                    |window, cx| {
                        let view = cx.new(|cx| workspace_view::WorkspaceView::new(window, cx));
                        let weak = view.downgrade();
                        window.on_window_should_close(cx, move |_, cx| {
                            let _ = weak.update(cx, |view, cx| view.prepare_close(cx));
                            true
                        });
                        view.update(cx, |view, cx| {
                            if std::env::args().any(|a| a == "--prompts") {
                                view.open_prompts(cx);
                            }
                            if std::env::args().any(|a| a == "--settings") {
                                view.open_settings(cx);
                            }
                            if std::env::args().any(|a| a == "--kit-smoke") {
                                view.start_kit_smoke(window, cx);
                            }
                            if std::env::args().any(|a| a == "--smoke-test") {
                                view.start_smoke(cx);
                            }
                            if std::env::args().any(|a| a == "--controller-smoke") {
                                view.start_controller_smoke(cx);
                            } else if std::env::args().any(|a| a == "--controller") {
                                view.open_controller(cx);
                            }
                            if std::env::args().any(|a| a == "--activity-smoke") {
                                view.start_activity_smoke(cx);
                            } else if std::env::args().any(|a| a == "--activity-monitor") {
                                view.open_activity(cx);
                            }
                        });
                        cx.new(|cx| {
                            gpui_kit::component::Root::new(view, window, cx)
                                .bg(gpui::transparent_black())
                        })
                    },
                )
                .expect("failed to open window");
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
}

fn verify_existing_data() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var_os("TBIAS_DATA_DIR").is_some(),
        "--check-data requires an isolated data copy"
    );
    let config = config::Config::load()?;
    let config_path = config::path()?;
    let text = std::fs::read_to_string(&config_path)?;
    let path = db::default_db_path()?;
    let mut conn = db::open(&path)?;
    let workspace = db::load_workspace(&conn)?;
    let prompts = prompts::Library::load(&conn)?;
    let preferences = activity::preferences::load(&path)?;
    if let Some(workspace) = &workspace {
        db::save_workspace(&mut conn, workspace, workspace_view::now())?;
    }
    prompts.save(&conn)?;
    activity::preferences::save(&path, &preferences)?;
    assert_eq!(db::load_workspace(&conn)?, workspace);
    assert_eq!(prompts::Library::load(&conn)?, prompts);
    assert_eq!(activity::preferences::load(&path)?, preferences);
    assert_eq!(config::save_settings(&config_path, &text, &config)?, text);
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    anyhow::ensure!(integrity == "ok", "database integrity: {integrity}");
    eprintln!("DATA_CONTINUITY_OK: {} tabs, {} prompts, {} queued; monitor preferences, config and controller profile preserved", workspace.as_ref().map_or(0, |w|w.tabs.len()), prompts.prompts.len(), prompts.queue.len());
    Ok(())
}
