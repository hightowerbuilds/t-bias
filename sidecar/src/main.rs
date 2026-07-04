// t-bias PTY sidecar.
//
// Owns pseudo-terminals via portable-pty and bridges them to the Deno
// supervisor over stdio using newline-delimited JSON (NDJSON).
//
//   Deno -> sidecar (stdin):
//     {"type":"spawn","paneId":N,"cols":C,"rows":R,"shell":"?","cwd":"?"}
//     {"type":"input","paneId":N,"data":"<base64>"}
//     {"type":"resize","paneId":N,"cols":C,"rows":R}
//     {"type":"close","paneId":N}
//
//   sidecar -> Deno (stdout):
//     {"type":"ready"}
//     {"type":"spawned","paneId":N,"pid":P,"command":"...","cwd":"..."}
//     {"type":"output","paneId":N,"data":"<base64>"}
//     {"type":"exit","paneId":N,"code":C}
//     {"type":"error","paneId":N,"message":"..."}
//
// PTY byte payloads are base64-encoded so binary data survives the JSON line
// protocol. When stdin closes (the Deno process is gone) every child PTY is
// terminated — the guaranteed cleanup path, replacing Tauri's RunEvent::Exit.

use base64::Engine;
use portable_pty::{
    ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const READ_BUF_SIZE: usize = 65536; // 64KB

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

type Out = Arc<Mutex<std::io::Stdout>>;
type Panes = Arc<Mutex<HashMap<u32, PaneState>>>;

struct PaneState {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    child_pid: Option<u32>,
    /// Signals the reader thread to stop emitting output after close.
    closed: Arc<AtomicBool>,
}

/// Emit one NDJSON frame to stdout, atomically (multiple threads write here).
fn emit(out: &Out, v: Value) {
    let mut line = v.to_string();
    line.push('\n');
    if let Ok(mut o) = out.lock() {
        let _ = o.write_all(line.as_bytes());
        let _ = o.flush();
    }
}

fn main() {
    let panes: Panes = Arc::new(Mutex::new(HashMap::new()));
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));

    emit(&out, json!({ "type": "ready" }));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let cmd = msg.get("type").and_then(Value::as_str).unwrap_or("");
        let pane_id = msg.get("paneId").and_then(Value::as_u64).unwrap_or(0) as u32;

        match cmd {
            "spawn" => {
                let cols = msg.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
                let rows = msg.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
                let shell = msg.get("shell").and_then(Value::as_str).map(String::from);
                let cwd = msg.get("cwd").and_then(Value::as_str).map(String::from);
                if let Err(e) = spawn(&panes, &out, pane_id, cols, rows, shell, cwd) {
                    emit(&out, json!({ "type": "error", "paneId": pane_id, "message": e }));
                }
            }
            "input" => {
                if let Some(data) = msg.get("data").and_then(Value::as_str) {
                    if let Ok(bytes) = B64.decode(data) {
                        let mut p = panes.lock().unwrap();
                        if let Some(pane) = p.get_mut(&pane_id) {
                            let _ = pane.writer.write_all(&bytes);
                            let _ = pane.writer.flush();
                        }
                    }
                }
            }
            "resize" => {
                let cols = msg.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
                let rows = msg.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
                let p = panes.lock().unwrap();
                if let Some(pane) = p.get(&pane_id) {
                    let _ = pane.master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
            "close" => close_pane(&panes, pane_id),
            _ => {}
        }
    }

    // stdin closed -> Deno is gone -> guarantee no orphaned shells.
    close_all(&panes);
}

fn spawn(
    panes: &Panes,
    out: &Out,
    pane_id: u32,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    // Idempotent: a remount must not double-spawn.
    if panes.lock().unwrap().contains_key(&pane_id) {
        return Ok(());
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Explicit shell resolution — GUI launches inherit a minimal env.
    let shell_path = match shell.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
    };

    let chosen_cwd: Option<std::path::PathBuf> = if let Ok(home) = std::env::var("HOME") {
        cwd.as_deref()
            .filter(|c| !c.is_empty())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(|| Some(std::path::PathBuf::from(&home)))
    } else {
        None
    };

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.arg("-l"); // login shell: source profiles, run path_helper
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "t-bias");
    cmd.env("TERM_PROGRAM_VERSION", "0.1.0");

    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
    if let Some(ref c) = chosen_cwd {
        cmd.cwd(c);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    let killer = child.clone_killer();
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let closed = Arc::new(AtomicBool::new(false));

    panes.lock().unwrap().insert(
        pane_id,
        PaneState {
            writer,
            master: pair.master,
            killer,
            child_pid,
            closed: Arc::clone(&closed),
        },
    );

    emit(
        &out,
        json!({
            "type": "spawned",
            "paneId": pane_id,
            "pid": child_pid,
            "command": shell_path,
            "cwd": chosen_cwd.as_deref().map(|p| p.to_string_lossy()).unwrap_or_default(),
        }),
    );

    // Reader thread: raw PTY output -> base64 NDJSON output frames.
    let out_r = Arc::clone(out);
    let closed_r = Arc::clone(&closed);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF_SIZE];
        loop {
            if closed_r.load(Ordering::Acquire) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if closed_r.load(Ordering::Acquire) {
                        break;
                    }
                    let data = B64.encode(&buf[..n]);
                    emit(&out_r, json!({ "type": "output", "paneId": pane_id, "data": data }));
                }
                Err(_) => break,
            }
        }
    });

    // Wait thread: notify Deno when the shell process exits.
    let out_e = Arc::clone(out);
    std::thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.as_ref().map(|s| s.exit_code() as i64);
        let success = status.map(|s| s.success()).unwrap_or(false);
        emit(
            &out_e,
            json!({ "type": "exit", "paneId": pane_id, "code": code, "success": success }),
        );
    });

    Ok(())
}

/// Terminate a pane's process group, then drop its state.
fn close_pane(panes: &Panes, pane_id: u32) {
    let pane = panes.lock().unwrap().remove(&pane_id);
    if let Some(mut pane) = pane {
        pane.closed.store(true, Ordering::Release);
        let fg = pane.master.process_group_leader();
        let shell_pgid = pane.child_pid.and_then(|pid| get_process_group_id(pid as i32));
        terminate_process_group(fg);
        if shell_pgid != fg {
            terminate_process_group(shell_pgid);
        }
        let _ = pane.killer.kill();
    }
}

fn close_all(panes: &Panes) {
    let ids: Vec<u32> = panes.lock().unwrap().keys().copied().collect();
    for id in ids {
        close_pane(panes, id);
    }
}

fn terminate_process_group(pgid: Option<i32>) {
    let Some(pgid) = pgid.filter(|p| *p > 0) else {
        return;
    };
    unsafe {
        // SIGHUP matches terminal hangup; SIGCONT resumes stopped jobs so the
        // hangup takes effect; SIGTERM for anything that ignores HUP.
        libc::killpg(pgid, libc::SIGHUP);
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
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
