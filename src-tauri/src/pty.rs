use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Maximum bytes to read in a single syscall.
const READ_BUF_SIZE: usize = 65536; // 64KB

struct PaneState {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child_pid: Option<u32>,
}

pub struct PtyState {
    panes: Mutex<HashMap<u32, PaneState>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub fn spawn_shell(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
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

    // Determine the shell binary explicitly — new_default_prog() relies on
    // env vars that may be missing in macOS .app bundles launched from Finder.
    let shell_path = match shell.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
    };

    let mut cmd = CommandBuilder::new(&shell_path);

    // Launch as a login shell so profile files are sourced (/etc/zprofile,
    // ~/.zprofile, etc.).  This is critical on macOS where .app bundles
    // inherit a minimal environment from launchd — login shells run
    // path_helper and user profiles that set up PATH properly.
    cmd.arg("-l");

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "t-bias");
    cmd.env("TERM_PROGRAM_VERSION", "0.1.0");

    // Ensure HOME is set and start in the user's home directory.
    // GUI apps on macOS may have cwd set to / or the .app bundle path.
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().to_string();
        cmd.env("HOME", &home_str);
        cmd.cwd(&home);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut panes = state.panes.lock().map_err(|e| e.to_string())?;
        panes.insert(pane_id, PaneState { writer, master: pair.master, child_pid });
    }

    // Reader thread: streams PTY output to the frontend via pane-specific event.
    let app_clone = app.clone();
    let out_event = format!("pty-output-{}", pane_id);
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

    // Child wait thread: notifies frontend when this pane's process exits.
    let exit_event = format!("pty-exit-{}", pane_id);
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app.emit(&exit_event, ());
    });

    Ok(())
}

#[tauri::command]
pub fn write_to_pty(
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
    data: String,
) -> Result<(), String> {
    let mut panes = state.panes.lock().map_err(|e| e.to_string())?;
    if let Some(pane) = panes.get_mut(&pane_id) {
        pane.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        pane.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let panes = state.panes.lock().map_err(|e| e.to_string())?;
    if let Some(pane) = panes.get(&pane_id) {
        pane.master
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

/// Drop a pane's PTY, killing the child process and freeing resources.
/// The reader thread will notice the closed master fd and exit naturally.
#[tauri::command]
pub fn close_pane(
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
) -> Result<(), String> {
    let mut panes = state.panes.lock().map_err(|e| e.to_string())?;
    panes.remove(&pane_id);
    Ok(())
}

/// Query the current working directory of a pane's shell process.
#[tauri::command]
pub fn get_pane_cwd(
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
) -> Result<Option<String>, String> {
    let panes = state.panes.lock().map_err(|e| e.to_string())?;
    let pid = match panes.get(&pane_id).and_then(|p| p.child_pid) {
        Some(pid) => pid,
        None => return Ok(None),
    };
    match get_pid_cwd(pid as i32) {
        Ok(cwd) => Ok(Some(cwd)),
        Err(_) => Ok(None),
    }
}

/// Read a process's current working directory using macOS's proc_pidinfo.
#[cfg(target_os = "macos")]
fn get_pid_cwd(pid: i32) -> Result<String, String> {
    use std::mem;
    unsafe {
        let mut info: libc::proc_vnodepathinfo = mem::zeroed();
        let size = mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let ret = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if ret <= 0 {
            return Err("proc_pidinfo failed".to_string());
        }
        let cstr = std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const _);
        Ok(cstr.to_string_lossy().into_owned())
    }
}

#[cfg(target_os = "linux")]
fn get_pid_cwd(pid: i32) -> Result<String, String> {
    std::fs::read_link(format!("/proc/{}/cwd", pid))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}
