// t-bias — terminal backend (Phase 1: PTY + alacritty_terminal spine).
//
// This is Zed's 3-layer terminal architecture, minus the rendering polish that
// lands in Phase 2. A `portable-pty` shell feeds bytes to alacritty's VTE
// `Processor`, which drives a `Term<TbiasListener>` behind an `Arc<FairMutex>`.
// Two detached threads do the blocking work:
//   * `pty_reader_loop`  — PTY -> Processor::advance(term) -> emit Wakeup
//   * `pty_message_loop` — Input / Resize / Shutdown -> PTY
// The GPUI side (see `main.rs`) drains the event channel and calls `cx.notify()`.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;

use alacritty_terminal::event::{Event as AlacEvent, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use anyhow::Result;
use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// Grid dimensions handed to alacritty. Alacritty is column/line oriented; the
/// pixel size only matters to full-screen apps and lands in Phase 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: usize,
    pub lines: usize,
}

impl TerminalSize {
    pub fn new(cols: usize, lines: usize) -> Self {
        Self {
            cols: cols.max(1),
            lines: lines.max(1),
        }
    }
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Alacritty `EventListener` that forwards terminal events to the GPUI thread
/// over an unbounded channel. `send_event` is called from the emulation layer.
#[derive(Clone)]
pub struct TbiasListener(UnboundedSender<AlacEvent>);

impl EventListener for TbiasListener {
    fn send_event(&self, event: AlacEvent) {
        // If the UI side has gone away the send just fails; nothing to do.
        let _ = self.0.unbounded_send(event);
    }
}

/// Control messages to the PTY writer thread.
pub enum Msg {
    Input(Vec<u8>),
    Resize(TerminalSize),
    Shutdown,
}

/// The terminal backend handle held by the GPUI view.
pub struct Terminal {
    term: Arc<FairMutex<Term<TbiasListener>>>,
    msg_tx: Sender<Msg>,
    /// The shell's pid, for querying its live working directory.
    shell_pid: Option<i32>,
}

impl Terminal {
    /// Spawn a shell and wire up the emulation pipeline. Returns the handle plus
    /// the receiver the GPUI side should drain (each item is a reason to repaint).
    pub fn new(size: TerminalSize) -> Result<(Self, UnboundedReceiver<AlacEvent>)> {
        let (event_tx, event_rx) = unbounded::<AlacEvent>();

        // Shared terminal state. The listener clone in the reader thread lets it
        // emit its own Wakeup after each parse pass (alacritty's own event_loop
        // would normally do this; we drive the parser by hand).
        let listener = TbiasListener(event_tx.clone());
        let term = Term::new(Config::default(), &size, listener);
        let term = Arc::new(FairMutex::new(term));

        // Open the PTY and spawn the user's login shell.
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: size.lines as u16,
            cols: size.cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(user_shell());
        cmd.arg("-l"); // login shell; a tty with no -c is interactive for zsh/bash
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(home) = std::env::var_os("HOME") {
            cmd.cwd(home);
        }

        let child = pair.slave.spawn_command(cmd)?;
        let shell_pid = child.process_id().map(|p| p as i32);
        // Drop the slave so the master read returns EOF when the child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let master = pair.master;

        // Reader thread: PTY bytes -> VTE parser -> Term, then signal a repaint.
        {
            let term = term.clone();
            thread::Builder::new()
                .name("tbias-pty-reader".into())
                .spawn(move || pty_reader_loop(reader, term, event_tx))
                .expect("spawn pty reader");
        }

        // Message thread: UI -> PTY (input, resize, shutdown).
        let (msg_tx, msg_rx) = mpsc::channel::<Msg>();
        thread::Builder::new()
            .name("tbias-pty-writer".into())
            .spawn(move || pty_message_loop(msg_rx, writer, master, child))
            .expect("spawn pty writer");

        Ok((
            Self {
                term,
                msg_tx,
                shell_pid,
            },
            event_rx,
        ))
    }

    /// The shell's current working directory (macOS: via `proc_pidinfo`).
    /// Follows `cd` — the explorer uses this to track "where the terminal is".
    pub fn cwd(&self) -> Option<PathBuf> {
        self.shell_pid.and_then(pid_cwd)
    }

    /// A cheap, cloneable handle the renderer uses to read the grid and push
    /// resizes. Lives on the UI thread only (the `mpsc::Sender` is `!Sync`).
    pub fn handle(&self) -> TerminalHandle {
        TerminalHandle {
            term: self.term.clone(),
            msg_tx: self.msg_tx.clone(),
        }
    }

}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.msg_tx.send(Msg::Shutdown);
    }
}

/// UI-thread handle for the renderer: read the shared grid, push resizes.
#[derive(Clone)]
pub struct TerminalHandle {
    term: Arc<FairMutex<Term<TbiasListener>>>,
    msg_tx: Sender<Msg>,
}

impl TerminalHandle {
    /// The shared terminal, for reading `renderable_content()` while painting.
    pub fn term(&self) -> &Arc<FairMutex<Term<TbiasListener>>> {
        &self.term
    }

    /// Write raw bytes to the shell.
    pub fn input(&self, bytes: impl Into<Vec<u8>>) {
        let _ = self.msg_tx.send(Msg::Input(bytes.into()));
    }

    /// Terminal is in application-cursor-keys mode (DECCKM) — affects arrow keys.
    pub fn app_cursor(&self) -> bool {
        self.term.lock().mode().contains(TermMode::APP_CURSOR)
    }

    /// Paste text, honoring bracketed-paste mode and normalizing newlines to CR.
    pub fn paste(&self, text: &str) {
        let bracketed = self.term.lock().mode().contains(TermMode::BRACKETED_PASTE);
        let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
        let mut bytes = Vec::with_capacity(normalized.len() + 12);
        if bracketed {
            bytes.extend_from_slice(b"\x1b[200~");
            bytes.extend_from_slice(normalized.as_bytes());
            bytes.extend_from_slice(b"\x1b[201~");
        } else {
            bytes.extend_from_slice(normalized.as_bytes());
        }
        let _ = self.msg_tx.send(Msg::Input(bytes));
    }

    /// Scroll the viewport within the scrollback.
    pub fn scroll(&self, scroll: Scroll) {
        self.term.lock().scroll_display(scroll);
    }

    /// Jump the viewport back to the live prompt (used on keypress).
    pub fn scroll_to_bottom(&self) {
        self.term.lock().scroll_display(Scroll::Bottom);
    }

    /// Reflow the emulator grid and the PTY to a new cell size. No-op if the
    /// grid already has these dimensions (so the render loop can call it freely).
    pub fn resize_to(&self, size: TerminalSize) {
        let mut term = self.term.lock();
        if term.columns() == size.cols && term.screen_lines() == size.lines {
            return;
        }
        term.resize(size);
        drop(term);
        let _ = self.msg_tx.send(Msg::Resize(size));
    }
}

/// Blocking loop: read PTY output, feed the VTE parser, poke the UI to repaint.
fn pty_reader_loop(
    mut reader: Box<dyn Read + Send>,
    term: Arc<FairMutex<Term<TbiasListener>>>,
    event_tx: UnboundedSender<AlacEvent>,
) {
    let mut processor: Processor<StdSyncHandler> = Processor::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,             // EOF: shell closed the PTY
            Err(_) => break,            // read error: treat as gone
            Ok(n) => {
                {
                    let mut term = term.lock();
                    processor.advance(&mut *term, &buf[..n]);
                }
                // New grid content is ready; ask the UI to repaint. (Redundant
                // wakeups during synchronized-output windows are harmless.)
                if event_tx.unbounded_send(AlacEvent::Wakeup).is_err() {
                    break;
                }
            }
        }
    }
    // Shell is gone — tell the UI so it can mark the pane dead.
    let _ = event_tx.unbounded_send(AlacEvent::Exit);
}

/// Blocking loop: apply UI-originated messages to the PTY.
fn pty_message_loop(
    rx: Receiver<Msg>,
    mut writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Input(bytes) => {
                let _ = writer.write_all(&bytes);
                let _ = writer.flush();
            }
            Msg::Resize(size) => {
                let _ = master.resize(PtySize {
                    rows: size.lines as u16,
                    cols: size.cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            Msg::Shutdown => {
                let _ = child.kill();
                break;
            }
        }
    }
}

/// The user's preferred shell, falling back to a sane default.
fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// A process's current working directory on macOS, via `proc_pidinfo`
/// (`PROC_PIDVNODEPATHINFO`). Returns None if the process is gone or the call
/// fails.
#[cfg(target_os = "macos")]
fn pid_cwd(pid: i32) -> Option<PathBuf> {
    // SAFETY: `info` is zero-initialized POD; we pass its exact size and only
    // read `vip_path` up to its first NUL after a successful call.
    unsafe {
        let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        let ret = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if ret < size {
            return None;
        }
        // libc types `vip_path` as `[[c_char; 32]; 32]` (a 1024-byte NUL-
        // terminated buffer); flatten and read up to the NUL.
        let flat: Vec<u8> = info
            .pvi_cdir
            .vip_path
            .iter()
            .flatten()
            .map(|&c| c as u8)
            .collect();
        let len = flat.iter().position(|&b| b == 0).unwrap_or(flat.len());
        if len == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf8_lossy(&flat[..len]).into_owned()))
    }
}

#[cfg(not(target_os = "macos"))]
fn pid_cwd(_pid: i32) -> Option<PathBuf> {
    None
}
