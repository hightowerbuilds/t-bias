// t-bias — sandboxed filesystem access (Phase 6).
//
// A root-guarded view of the filesystem for the file explorer: list and read
// paths, but never escape the sandbox root. Ported from the Deno app's
// `fs/sandbox.ts`. The path guard is lexical (resolves `.`/`..` without touching
// the disk) and *clamps* at the root, so no `..` sequence can traverse out —
// this is the security-critical part and is unit-tested directly.
//
// The explorer UI wires on top of this in a later Phase 6 slice (needs the
// text-rendering fix); this module is UI-free and headless-testable.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// The kind of a directory entry (symlinks are reported as such, not followed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Directory,
    File,
    Symlink,
}

/// One entry in a directory listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
}

/// A filesystem rooted at (and confined to) a directory.
#[derive(Clone, Debug)]
pub struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Root from `$TBIAS_FS_ROOT`, falling back to the current dir.
    pub fn from_env_or_cwd() -> Result<Self> {
        let root = match std::env::var_os("TBIAS_FS_ROOT") {
            Some(r) => PathBuf::from(r),
            None => std::env::current_dir().context("resolving current dir")?,
        };
        Ok(Self::new(root))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a sandbox-relative path to an absolute path under the root.
    ///
    /// Leading slashes are treated as relative to the root, and `..` components
    /// are clamped at the root — the returned path is *always* within the
    /// sandbox, so traversal out is impossible.
    pub fn resolve(&self, subpath: &str) -> PathBuf {
        let mut stack: Vec<&str> = Vec::new();
        for comp in subpath.split(['/', '\\']) {
            match comp {
                "" | "." => {}
                ".." => {
                    stack.pop(); // clamp: popping past the root is a no-op
                }
                name => stack.push(name),
            }
        }
        let mut path = self.root.clone();
        for comp in stack {
            path.push(comp);
        }
        path
    }

    /// List a directory (dirs first, then case-insensitive by name).
    pub fn list_dir(&self, subpath: &str) -> Result<Vec<DirEntry>> {
        let path = self.resolve(subpath);
        let mut entries = Vec::new();
        let read = std::fs::read_dir(&path)
            .with_context(|| format!("reading dir {}", path.display()))?;
        for entry in read {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let kind = if file_type.is_symlink() {
                EntryKind::Symlink
            } else if file_type.is_dir() {
                EntryKind::Directory
            } else {
                EntryKind::File
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push(DirEntry { name, kind });
        }
        sort_entries(&mut entries);
        Ok(entries)
    }

    /// Read a file as UTF-8 text.
    pub fn read_text(&self, subpath: &str) -> Result<String> {
        let path = self.resolve(subpath);
        std::fs::read_to_string(&path).with_context(|| format!("reading file {}", path.display()))
    }
}

/// Sort directory entries: directories first, then case-insensitive by name
/// (with a case-sensitive tiebreak for stability).
fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.kind != EntryKind::Directory;
        let b_dir = b.kind != EntryKind::Directory;
        a_dir
            .cmp(&b_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_stays_within_root_on_traversal() {
        let sb = Sandbox::new("/srv/root");
        // Plain relative path.
        assert_eq!(sb.resolve("docs/readme.md"), PathBuf::from("/srv/root/docs/readme.md"));
        // `..` is clamped — cannot escape the root.
        assert_eq!(sb.resolve("../../etc/passwd"), PathBuf::from("/srv/root/etc/passwd"));
        assert_eq!(sb.resolve("a/../../b"), PathBuf::from("/srv/root/b"));
        // Leading slash is relative to the root, not absolute.
        assert_eq!(sb.resolve("/abs/path"), PathBuf::from("/srv/root/abs/path"));
        // `.` and empty components are ignored.
        assert_eq!(sb.resolve("./a//./b/"), PathBuf::from("/srv/root/a/b"));
        // Every resolution is under the root.
        for probe in ["..", "../..", "a/../../../..", "/../../"] {
            assert!(sb.resolve(probe).starts_with("/srv/root"));
        }
    }

    #[test]
    fn sort_puts_dirs_first_then_case_insensitive() {
        let mut v = vec![
            DirEntry { name: "banana.txt".into(), kind: EntryKind::File },
            DirEntry { name: "Zeta".into(), kind: EntryKind::Directory },
            DirEntry { name: "apple".into(), kind: EntryKind::Directory },
            DirEntry { name: "Alpha.md".into(), kind: EntryKind::File },
            DirEntry { name: "link".into(), kind: EntryKind::Symlink },
        ];
        sort_entries(&mut v);
        let names: Vec<&str> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["apple", "Zeta", "Alpha.md", "banana.txt", "link"]);
    }

    /// A scratch directory under the system temp dir, cleaned up on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tbias-fs-{}-{}", tag, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_and_read_within_sandbox() {
        let scratch = Scratch::new("listread");
        let root = &scratch.0;
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("b.txt"), "hello").unwrap();
        std::fs::write(root.join("A.txt"), "world").unwrap();

        let sb = Sandbox::new(root);
        let entries = sb.list_dir(".").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directory first, then files case-insensitively.
        assert_eq!(names, vec!["sub", "A.txt", "b.txt"]);
        assert_eq!(entries[0].kind, EntryKind::Directory);

        assert_eq!(sb.read_text("b.txt").unwrap(), "hello");
        assert_eq!(sb.read_text("sub/../A.txt").unwrap(), "world");
    }

    #[test]
    fn traversal_cannot_read_outside_root() {
        let scratch = Scratch::new("escape");
        let root = scratch.0.join("root");
        std::fs::create_dir_all(&root).unwrap();
        // A secret sitting *outside* the sandbox root but inside the scratch dir.
        std::fs::write(scratch.0.join("secret.txt"), "TOP SECRET").unwrap();

        let sb = Sandbox::new(&root);
        // The `..` is clamped, so this resolves to <root>/secret.txt (absent),
        // never the sibling secret — the read fails instead of leaking it.
        assert!(sb.read_text("../secret.txt").is_err());
        assert!(sb.resolve("../secret.txt").starts_with(&root));
    }
}
