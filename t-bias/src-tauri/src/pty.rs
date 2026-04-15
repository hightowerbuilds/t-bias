use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Maximum bytes to read in a single syscall.
const READ_BUF_SIZE: usize = 65536; // 64KB

struct TabPty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

pub struct PtyState {
    tabs: Mutex<HashMap<u32, TabPty>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            tabs: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub fn spawn_shell(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    tab_id: u32,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
    let pty_system = NativePtySystem::default();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = match shell.as_deref() {
        Some(s) if !s.is_empty() => CommandBuilder::new(s),
        _ => CommandBuilder::new_default_prog(),
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut tabs = state.tabs.lock().map_err(|e| e.to_string())?;
        tabs.insert(tab_id, TabPty { writer, master: pair.master });
    }

    // Reader thread: streams PTY output to the frontend via tab-specific event.
    let app_clone = app.clone();
    let out_event = format!("pty-output-{}", tab_id);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF_SIZE];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&out_event, text);
                }
                Err(_) => break,
            }
        }
    });

    // Child wait thread: notifies frontend when this tab's process exits.
    let exit_event = format!("pty-exit-{}", tab_id);
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app.emit(&exit_event, ());
    });

    Ok(())
}

#[tauri::command]
pub fn write_to_pty(
    state: tauri::State<'_, PtyState>,
    tab_id: u32,
    data: String,
) -> Result<(), String> {
    let mut tabs = state.tabs.lock().map_err(|e| e.to_string())?;
    if let Some(tab) = tabs.get_mut(&tab_id) {
        tab.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        tab.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, PtyState>,
    tab_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let tabs = state.tabs.lock().map_err(|e| e.to_string())?;
    if let Some(tab) = tabs.get(&tab_id) {
        tab.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drop a tab's PTY, killing the child process and freeing resources.
/// The reader thread will notice the closed master fd and exit naturally.
#[tauri::command]
pub fn close_tab(
    state: tauri::State<'_, PtyState>,
    tab_id: u32,
) -> Result<(), String> {
    let mut tabs = state.tabs.lock().map_err(|e| e.to_string())?;
    tabs.remove(&tab_id);
    Ok(())
}
