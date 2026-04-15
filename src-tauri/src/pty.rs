use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Maximum bytes to read in a single syscall.
const READ_BUF_SIZE: usize = 65536; // 64KB

pub struct PtyState {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            master: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub fn spawn_shell(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    cols: u16,
    rows: u16,
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

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut w = state.writer.lock().map_err(|e| e.to_string())?;
        *w = Some(writer);
    }
    {
        let mut m = state.master.lock().map_err(|e| e.to_string())?;
        *m = Some(pair.master);
    }

    // Reader thread: streams PTY output to the frontend.
    // Simple blocking-read loop: emit each chunk as it arrives.
    // The 64KB read buffer naturally coalesces rapid output (the kernel
    // accumulates PTY data between reads), and the frontend's write buffer
    // + requestAnimationFrame further batches before rendering.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF_SIZE];

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("pty-output", text);
                }
                Err(_) => break,
            }
        }
    });

    // Child wait thread: notifies frontend when process exits
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app.emit("pty-exit", ());
    });

    Ok(())
}

#[tauri::command]
pub fn write_to_pty(state: tauri::State<'_, PtyState>, data: String) -> Result<(), String> {
    let mut w = state.writer.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut writer) = *w {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(state: tauri::State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let m = state.master.lock().map_err(|e| e.to_string())?;
    if let Some(ref master) = *m {
        master
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
