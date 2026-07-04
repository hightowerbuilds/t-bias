// t-bias — read-only file explorer (Phase 6).
//
// A sandboxed, read-only view of the repo the app was launched in. Navigation
// state only (current directory + listing); the rendering lives in `main.rs`
// where it has access to the view's click listeners. All access goes through
// `fs::Sandbox`, so browsing can never escape the repo root.

use crate::fs::{DirEntry, Sandbox};

/// Explorer navigation state: a directory listing rooted at the repo.
pub struct Explorer {
    sandbox: Sandbox,
    /// Current directory relative to the sandbox root ("" = the root itself).
    rel: String,
    entries: Vec<DirEntry>,
    error: Option<String>,
}

impl Explorer {
    /// Root the explorer at `$TBIAS_FS_ROOT` or the current working directory.
    pub fn new() -> Self {
        let sandbox = Sandbox::from_env_or_cwd().unwrap_or_else(|_| Sandbox::new("."));
        let mut explorer = Self {
            sandbox,
            rel: String::new(),
            entries: Vec::new(),
            error: None,
        };
        explorer.refresh();
        explorer
    }

    /// Re-read the current directory.
    pub fn refresh(&mut self) {
        match self.sandbox.list_dir(&self.rel) {
            Ok(entries) => {
                self.entries = entries;
                self.error = None;
            }
            Err(err) => {
                self.entries.clear();
                self.error = Some(format!("{err:#}"));
            }
        }
    }

    /// Descend into a child directory.
    pub fn enter(&mut self, name: &str) {
        self.rel = if self.rel.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", self.rel, name)
        };
        self.refresh();
    }

    /// Go up one directory (no-op at the root).
    pub fn up(&mut self) {
        match self.rel.rfind('/') {
            Some(idx) => self.rel.truncate(idx),
            None => self.rel.clear(),
        }
        self.refresh();
    }

    /// True when already at the repo root (nothing above).
    pub fn at_root(&self) -> bool {
        self.rel.is_empty()
    }

    pub fn entries(&self) -> &[DirEntry] {
        &self.entries
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// A human-readable path for the header: `<repo-name>/<rel>`.
    pub fn display_path(&self) -> String {
        let root_name = self
            .sandbox
            .root()
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.sandbox.root().display().to_string());
        if self.rel.is_empty() {
            root_name
        } else {
            format!("{root_name}/{}", self.rel)
        }
    }
}

impl Default for Explorer {
    fn default() -> Self {
        Self::new()
    }
}
