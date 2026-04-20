use tauri::Manager;

mod config;
mod fs_ops;
mod persistence;
mod pty;
mod prompt_stacker;
mod session;
mod shell_registry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_shell,
            pty::write_to_pty,
            pty::resize_pty,
            pty::close_pane,
            config::get_config,
            fs_ops::read_dir,
            fs_ops::read_file,
            fs_ops::write_file,
            fs_ops::move_entry,
            fs_ops::create_dir,
            fs_ops::delete_entry,
            fs_ops::get_home_dir,
            fs_ops::resolve_existing_dir,
            pty::get_pane_cwd,
            pty::get_pane_foreground_process_name,
            prompt_stacker::get_prompt_stacker_state,
            prompt_stacker::save_prompt,
            prompt_stacker::edit_prompt,
            prompt_stacker::delete_prompt,
            prompt_stacker::duplicate_prompt,
            prompt_stacker::set_prompt_queue,
            prompt_stacker::export_prompts,
            prompt_stacker::import_prompts,
            shell_registry::prepare_shell_registry_for_launch,
            shell_registry::list_shell_records,
            shell_registry::create_shell_record,
            shell_registry::attach_shell_record,
            shell_registry::update_shell_record,
            shell_registry::close_shell_record,
            shell_registry::set_shell_persist_on_quit,
            shell_registry::prepare_shell_registry_for_shutdown,
            session::save_session,
            session::load_session,
            session::save_named_session,
            session::load_named_session,
            session::list_named_sessions,
            session::delete_named_session,
        ])
        .setup(|app| {
            // --config <path> CLI argument
            let args: Vec<String> = std::env::args().collect();
            if let Some(idx) = args.iter().position(|a| a == "--config") {
                if let Some(path) = args.get(idx + 1) {
                    config::set_config_path(std::path::PathBuf::from(path));
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Build native "View" menu with File Explorer and Code Editor items.
            use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
            let file_explorer_item = MenuItem::with_id(
                app, "open_file_explorer", "File Explorer", true, None::<&str>,
            )?;
            let code_editor_item = MenuItem::with_id(
                app, "open_code_editor", "Code Editor", true, None::<&str>,
            )?;
            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(&file_explorer_item)
                .item(&code_editor_item)
                .build()?;
            let menu = MenuBuilder::new(app).item(&view_submenu).build()?;
            app.set_menu(menu)?;

            app.on_menu_event(|app_handle, event| {
                use tauri::Emitter;
                match event.id().as_ref() {
                    "open_file_explorer" => {
                        let _ = app_handle.emit("open-file-explorer", ());
                    }
                    "open_code_editor" => {
                        let _ = app_handle.emit("open-code-editor", ());
                    }
                    _ => {}
                }
            });

            config::start_config_watcher(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Terminate every PTY child process before the app process exits.
                // This is the guaranteed cleanup path — it runs regardless of how
                // the app was closed (window X, Cmd+Q, forced quit).
                let state = app_handle.state::<pty::PtyState>();
                state.close_all();
            }
        });
}
