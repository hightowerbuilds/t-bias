// t-bias — read-only file explorer (Phase 6).
//
// A sandboxed, read-only view of the repo the app was launched in. Navigation
// state only (current directory + listing); the rendering lives in `main.rs`
// where it has access to the view's click listeners. All access goes through
// `fs::Sandbox`, so browsing can never escape the repo root.

use std::path::{Path, PathBuf};

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

    /// Re-root the explorer to follow the terminal: anchor the sandbox at the
    /// git repo containing `cwd` (or `cwd` itself if not in a repo) and open at
    /// the terminal's current subdirectory within it. So `cd`-ing around the
    /// repo, then flipping, lands you exactly where the shell is — and `..` can
    /// browse up to the repo root but no further.
    pub fn follow(&mut self, cwd: &Path) {
        let (root, rel) = repo_location(cwd);
        self.sandbox = Sandbox::new(root);
        self.rel = rel;
        self.refresh();
        // If the subdir can't be read for any reason, fall back to the root.
        if self.error.is_some() && !self.rel.is_empty() {
            self.rel.clear();
            self.refresh();
        }
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

/// Resolve `cwd` to (repo root, path-relative-to-root). The repo root is the
/// nearest ancestor containing `.git`; if there is none, the root is `cwd`
/// itself (rel = "").
fn repo_location(cwd: &Path) -> (PathBuf, String) {
    let root = find_repo_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let rel = cwd
        .strip_prefix(&root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    (root, rel)
}

/// Nearest ancestor of `start` (inclusive) that contains a `.git` entry.
fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_location_finds_git_root_and_rel() {
        // Build a temp repo: <tmp>/repo/.git and <tmp>/repo/a/b.
        let base =
            std::env::temp_dir().join(format!("tbias-explorer-{}", std::process::id()));
        let repo = base.join("repo");
        let deep = repo.join("a/b");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&deep).unwrap();

        let (root, rel) = repo_location(&deep);
        assert_eq!(root, repo);
        assert_eq!(rel, "a/b");

        // At the repo root, rel is empty.
        let (root2, rel2) = repo_location(&repo);
        assert_eq!(root2, repo);
        assert_eq!(rel2, "");

        // Outside any repo: root = the dir itself.
        let no_repo = base.join("loose");
        std::fs::create_dir_all(&no_repo).unwrap();
        let (root3, rel3) = repo_location(&no_repo);
        assert_eq!(root3, no_repo);
        assert_eq!(rel3, "");

        let _ = std::fs::remove_dir_all(&base);
    }
}
