use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Maximum bytes to read in a single syscall.
const READ_BUF_SIZE: usize = 65536; // 64KB

struct PaneState {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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

    /// Terminate every tracked PTY process. Called from the Tauri exit handler
    /// to guarantee child processes do not outlive the app.
    pub fn close_all(&self) {
        let mut panes = match self.panes.lock() {
            Ok(panes) => panes,
            Err(poisoned) => poisoned.into_inner(),
        };
        let pane_ids: Vec<u32> = panes.keys().copied().collect();
        for pane_id in pane_ids {
            if let Some(mut pane) = panes.remove(&pane_id) {
                let foreground_pgid = pane.master.process_group_leader();
                let shell_pgid = pane
                    .child_pid
                    .and_then(|pid| get_process_group_id(pid as i32));
                log::info!(
                    "close_all pane_id={} child_pid={:?} fg_pgid={:?} shell_pgid={:?}",
                    pane_id,
                    pane.child_pid,
                    foreground_pgid,
                    shell_pgid,
                );
                terminate_process_group(foreground_pgid);
                if shell_pgid != foreground_pgid {
                    terminate_process_group(shell_pgid);
                }
                let _ = pane.killer.kill();
            }
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
    cwd: Option<String>,
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

    // Ensure HOME is set. GUI apps on macOS may have cwd set to / or the
    // .app bundle path, so default to HOME unless the frontend provided a cwd.
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().to_string();
        cmd.env("HOME", &home_str);

        if let Some(cwd) = cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
            let cwd_path = std::path::PathBuf::from(cwd);
            if cwd_path.exists() && cwd_path.is_dir() {
                cmd.cwd(cwd_path);
            } else {
                cmd.cwd(&home);
            }
        } else {
            cmd.cwd(&home);
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    let killer = child.clone_killer();
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut panes = state.panes.lock().map_err(|e| e.to_string())?;
        panes.insert(
            pane_id,
            PaneState {
                writer,
                master: pair.master,
                killer,
                child_pid,
            },
        );
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

/// Explicitly terminate a pane's child process and then drop its PTY state.
/// The reader thread will notice the closed master fd and exit naturally.
#[tauri::command]
pub fn close_pane(
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
) -> Result<(), String> {
    let mut panes = state.panes.lock().map_err(|e| e.to_string())?;
    if let Some(mut pane) = panes.remove(&pane_id) {
        let foreground_pgid = pane.master.process_group_leader();
        let shell_pgid = pane
            .child_pid
            .and_then(|pid| get_process_group_id(pid as i32));

        log::info!(
            "close_pane pane_id={} child_pid={:?} fg_pgid={:?} shell_pgid={:?}",
            pane_id,
            pane.child_pid,
            foreground_pgid,
            shell_pgid
        );

        // Terminate the active PTY process group first so foreground jobs like
        // `sleep`, `vim`, or `less` do not outlive the pane close. Follow with
        // the shell killer as a cleanup path for the original child handle.
        terminate_process_group(foreground_pgid);
        if shell_pgid != foreground_pgid {
            terminate_process_group(shell_pgid);
        }
        let _ = pane.killer.kill();
    }
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

/// Query the current foreground process name of a pane's PTY.
#[tauri::command]
pub fn get_pane_foreground_process_name(
    state: tauri::State<'_, PtyState>,
    pane_id: u32,
) -> Result<Option<String>, String> {
    let panes = state.panes.lock().map_err(|e| e.to_string())?;
    let pane = match panes.get(&pane_id) {
        Some(pane) => pane,
        None => return Ok(None),
    };

    let fg_pid = match pane.master.process_group_leader() {
        Some(pid) if pid > 0 => pid,
        _ => return Ok(None),
    };

    if pane.child_pid == Some(fg_pid as u32) {
        return Ok(None);
    }

    let process_name = match get_pid_name(fg_pid) {
        Ok(name) if !name.is_empty() => name,
        _ => return Ok(None),
    };

    if is_shell_process(&process_name) {
        return Ok(None);
    }

    let exec_path = get_pid_executable_path(fg_pid).ok();
    Ok(Some(format_process_title(&process_name, exec_path.as_deref())))
}

fn is_shell_process(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "sh" | "bash" | "zsh" | "fish" | "dash" | "ksh" | "tcsh" | "csh" | "nu" | "pwsh" | "powershell" | "login"
    )
}

fn terminate_process_group(pgid: Option<i32>) {
    let Some(pgid) = pgid.filter(|pgid| *pgid > 0) else {
        return;
    };

    log::info!("terminate_process_group pgid={}", pgid);
    unsafe {
        // SIGHUP matches terminal hangup semantics and terminates most
        // foreground PTY jobs cleanly.
        libc::killpg(pgid, libc::SIGHUP);
        // Resume any stopped process so the hangup can take effect.
        libc::killpg(pgid, libc::SIGCONT);
        libc::killpg(pgid, libc::SIGTERM);
    }

    if process_group_exists(pgid) {
        std::thread::sleep(Duration::from_millis(60));
    }

    if process_group_exists(pgid) {
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
}

fn get_process_group_id(pid: i32) -> Option<i32> {
    if pid <= 0 {
        return None;
    }
    match unsafe { libc::getpgid(pid) } {
        pgid if pgid > 0 => Some(pgid),
        _ => None,
    }
}

fn process_group_exists(pgid: i32) -> bool {
    if pgid <= 0 {
        return false;
    }

    let result = unsafe { libc::kill(-pgid, 0) };
    if result == 0 {
        true
    } else {
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn format_process_title(process_name: &str, exec_path: Option<&str>) -> String {
    let process_name = process_name.trim();
    let exec_basename = exec_path
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or(process_name)
        .trim();

    for candidate in [process_name, exec_basename] {
        if let Some(title) = known_process_title(candidate) {
            return title.to_string();
        }
    }

    prettify_process_name(exec_basename)
}

fn known_process_title(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => Some("Claude Code"),
        "codex" => Some("Codex"),
        "aider" => Some("Aider"),
        "gemini" => Some("Gemini"),
        "opencode" => Some("OpenCode"),
        "goose" => Some("Goose"),
        "cursor-agent" | "cursor-agent-cli" => Some("Cursor Agent"),
        "qodo" => Some("Qodo"),
        "amp" => Some("Amp"),
        "vim" => Some("Vim"),
        "nvim" => Some("Neovim"),
        "tmux" => Some("tmux"),
        "less" => Some("Less"),
        "man" => Some("Man"),
        "htop" => Some("htop"),
        "top" => Some("top"),
        _ => None,
    }
}

fn prettify_process_name(name: &str) -> String {
    let pretty = name
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    let mut out = String::new();
                    out.extend(first.to_uppercase());
                    out.push_str(&chars.as_str().to_ascii_lowercase());
                    out
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if pretty.is_empty() {
        "Shell".to_string()
    } else {
        pretty
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

#[cfg(target_os = "macos")]
fn get_pid_name(pid: i32) -> Result<String, String> {
    let mut buf = [0u8; 256];
    let ret = unsafe {
        libc::proc_name(
            pid,
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len() as u32,
        )
    };
    if ret <= 0 {
        return Err("proc_name failed".to_string());
    }
    let len = buf.iter().position(|&b| b == 0).unwrap_or(ret as usize);
    Ok(String::from_utf8_lossy(&buf[..len]).trim().to_string())
}

#[cfg(target_os = "linux")]
fn get_pid_name(pid: i32) -> Result<String, String> {
    std::fs::read_to_string(format!("/proc/{}/comm", pid))
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn get_pid_executable_path(pid: i32) -> Result<String, String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let ret = unsafe {
        libc::proc_pidpath(
            pid,
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len() as u32,
        )
    };
    if ret <= 0 {
        return Err("proc_pidpath failed".to_string());
    }
    let len = buf.iter().position(|&b| b == 0).unwrap_or(ret as usize);
    Ok(String::from_utf8_lossy(&buf[..len]).to_string())
}

#[cfg(target_os = "linux")]
fn get_pid_executable_path(pid: i32) -> Result<String, String> {
    std::fs::read_link(format!("/proc/{}/exe", pid))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}
