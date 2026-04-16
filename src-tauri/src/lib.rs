mod config;
mod fs_ops;
mod pty;
mod prompt_stacker;
mod session;

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
            session::save_session,
            session::load_session,
            session::save_named_session,
            session::load_named_session,
            session::list_named_sessions,
            session::delete_named_session,
            fs_ops::read_dir,
            fs_ops::read_file,
            fs_ops::write_file,
            fs_ops::move_entry,
            fs_ops::create_dir,
            fs_ops::delete_entry,
            fs_ops::get_home_dir,
            pty::get_pane_cwd,
            pty::get_pane_foreground_process_name,
            prompt_stacker::list_prompts,
            prompt_stacker::save_prompt,
        ])
        .setup(|app| {
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
