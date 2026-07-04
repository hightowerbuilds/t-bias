// t-bias — keyboard input encoding (Phase 3).
//
// Translates a keystroke into the byte sequence a terminal expects on the PTY.
// Kept as a pure function (no gpui types) so it can be unit-tested directly —
// the mapping is fiddly (control codes, CSI sequences, application-cursor mode,
// modifier parameters) and worth pinning down with tests rather than eyeballing
// it in a running app.
//
// References: xterm control sequences / DEC VT100. The modifier parameter for
// CSI sequences is `1 + shift + 2*alt + 4*ctrl` (so plain = 1, shift = 2, …).

/// The modifier keys held during a keystroke (cmd is macOS ⌘).
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct KeyMods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub cmd: bool,
}

/// Encode a keystroke into PTY bytes.
///
/// * `key` — GPUI's key name ("a", "enter", "up", "f5", …).
/// * `key_char` — the character the key would type (respecting shift/option), if any.
/// * `mods` — held modifiers.
/// * `app_cursor` — terminal is in application-cursor-keys mode (DECCKM).
///
/// Returns `None` when the keystroke produces no PTY output (e.g. a ⌘ shortcut,
/// which the caller handles separately).
pub fn encode_key(
    key: &str,
    key_char: Option<&str>,
    mods: KeyMods,
    app_cursor: bool,
) -> Option<Vec<u8>> {
    // ⌘ combos are app shortcuts (copy/paste/etc.), never sent to the shell.
    if mods.cmd {
        return None;
    }

    // Modifier parameter for CSI sequences: plain = 1, +shift, +2·alt, +4·ctrl.
    let modifier = 1 + (mods.shift as u8) + (mods.alt as u8) * 2 + (mods.ctrl as u8) * 4;
    let modified = modifier > 1;

    // Cursor/edit keys ending in a letter (A/B/C/D/H/F). Application mode swaps
    // the CSI introducer `ESC [` for `ESC O`, but only when unmodified.
    let csi_letter = |c: char| -> Vec<u8> {
        if modified {
            format!("\x1b[1;{modifier}{c}").into_bytes()
        } else if app_cursor {
            format!("\x1bO{c}").into_bytes()
        } else {
            format!("\x1b[{c}").into_bytes()
        }
    };
    // Edit keys of the form `ESC [ n ~` (with an optional modifier parameter).
    let tilde = |n: u32| -> Vec<u8> {
        if modified {
            format!("\x1b[{n};{modifier}~").into_bytes()
        } else {
            format!("\x1b[{n}~").into_bytes()
        }
    };

    match key {
        "enter" => Some(alt_prefix(mods, vec![b'\r'])),
        "tab" => Some(if mods.shift {
            b"\x1b[Z".to_vec() // back-tab (CBT)
        } else {
            vec![b'\t']
        }),
        "backspace" => Some(if mods.ctrl {
            vec![0x08] // Ctrl-Backspace -> BS
        } else {
            alt_prefix(mods, vec![0x7f]) // DEL
        }),
        "escape" => Some(vec![0x1b]),
        "space" => Some(if mods.ctrl {
            vec![0x00] // Ctrl-Space -> NUL
        } else {
            alt_prefix(mods, vec![b' '])
        }),
        "up" => Some(csi_letter('A')),
        "down" => Some(csi_letter('B')),
        "right" => Some(csi_letter('C')),
        "left" => Some(csi_letter('D')),
        "home" => Some(csi_letter('H')),
        "end" => Some(csi_letter('F')),
        "pageup" => Some(tilde(5)),
        "pagedown" => Some(tilde(6)),
        "insert" => Some(tilde(2)),
        "delete" => Some(tilde(3)),
        "f1" => Some(fkey_ss3('P', modifier, modified)),
        "f2" => Some(fkey_ss3('Q', modifier, modified)),
        "f3" => Some(fkey_ss3('R', modifier, modified)),
        "f4" => Some(fkey_ss3('S', modifier, modified)),
        "f5" => Some(tilde(15)),
        "f6" => Some(tilde(17)),
        "f7" => Some(tilde(18)),
        "f8" => Some(tilde(19)),
        "f9" => Some(tilde(20)),
        "f10" => Some(tilde(21)),
        "f11" => Some(tilde(23)),
        "f12" => Some(tilde(24)),
        _ => {
            if mods.ctrl {
                // Control character from the base key (Ctrl-C -> 0x03, etc.).
                let base = key.chars().next()?;
                let byte = control_byte(base)?;
                Some(alt_prefix(mods, vec![byte]))
            } else if let Some(ch) = key_char {
                // Printable input — key_char already reflects shift/option.
                Some(alt_prefix(mods, ch.as_bytes().to_vec()))
            } else if key.chars().count() == 1 {
                Some(alt_prefix(mods, key.as_bytes().to_vec()))
            } else {
                None
            }
        }
    }
}

/// F1-F4 use SS3 (`ESC O x`) unmodified, but the CSI form when modified.
fn fkey_ss3(final_byte: char, modifier: u8, modified: bool) -> Vec<u8> {
    if modified {
        format!("\x1b[1;{modifier}{final_byte}").into_bytes()
    } else {
        format!("\x1bO{final_byte}").into_bytes()
    }
}

/// Alt/Meta prefixes a sequence with ESC (unless alt isn't held).
fn alt_prefix(mods: KeyMods, mut bytes: Vec<u8>) -> Vec<u8> {
    if mods.alt {
        let mut out = Vec::with_capacity(bytes.len() + 1);
        out.push(0x1b);
        out.append(&mut bytes);
        out
    } else {
        bytes
    }
}

/// Map a key to its control byte (Ctrl-A -> 0x01 … Ctrl-Z -> 0x1a, plus the
/// classic symbol controls). Returns None if the key has no control code.
fn control_byte(c: char) -> Option<u8> {
    let c = c.to_ascii_uppercase();
    match c {
        '@' | '2' => Some(0x00),
        'A'..='Z' => Some(c as u8 - b'A' + 1),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '7' | '/' => Some(0x1f),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctrl() -> KeyMods {
        KeyMods {
            ctrl: true,
            ..Default::default()
        }
    }
    fn alt() -> KeyMods {
        KeyMods {
            alt: true,
            ..Default::default()
        }
    }
    fn shift() -> KeyMods {
        KeyMods {
            shift: true,
            ..Default::default()
        }
    }

    #[test]
    fn printable() {
        assert_eq!(encode_key("a", Some("a"), KeyMods::default(), false), Some(b"a".to_vec()));
        // Shift is already folded into key_char.
        assert_eq!(encode_key("a", Some("A"), shift(), false), Some(b"A".to_vec()));
    }

    #[test]
    fn enter_tab_backspace_escape() {
        assert_eq!(encode_key("enter", None, KeyMods::default(), false), Some(vec![b'\r']));
        assert_eq!(encode_key("tab", None, KeyMods::default(), false), Some(vec![b'\t']));
        assert_eq!(encode_key("tab", None, shift(), false), Some(b"\x1b[Z".to_vec()));
        assert_eq!(encode_key("backspace", None, KeyMods::default(), false), Some(vec![0x7f]));
        assert_eq!(encode_key("escape", None, KeyMods::default(), false), Some(vec![0x1b]));
    }

    #[test]
    fn control_chars() {
        assert_eq!(encode_key("c", Some("c"), ctrl(), false), Some(vec![0x03])); // Ctrl-C
        assert_eq!(encode_key("d", Some("d"), ctrl(), false), Some(vec![0x04])); // Ctrl-D
        assert_eq!(encode_key("z", Some("z"), ctrl(), false), Some(vec![0x1a])); // Ctrl-Z
        assert_eq!(encode_key("space", None, ctrl(), false), Some(vec![0x00])); // Ctrl-Space
    }

    #[test]
    fn alt_prefixes_escape() {
        assert_eq!(encode_key("b", Some("b"), alt(), false), Some(vec![0x1b, b'b']));
        assert_eq!(encode_key("enter", None, alt(), false), Some(vec![0x1b, b'\r']));
    }

    #[test]
    fn arrows_normal_vs_application() {
        assert_eq!(encode_key("up", None, KeyMods::default(), false), Some(b"\x1b[A".to_vec()));
        assert_eq!(encode_key("up", None, KeyMods::default(), true), Some(b"\x1bOA".to_vec()));
        assert_eq!(encode_key("left", None, KeyMods::default(), false), Some(b"\x1b[D".to_vec()));
        // A modifier forces the CSI form even in application mode.
        assert_eq!(encode_key("up", None, shift(), true), Some(b"\x1b[1;2A".to_vec()));
    }

    #[test]
    fn edit_and_function_keys() {
        assert_eq!(encode_key("pageup", None, KeyMods::default(), false), Some(b"\x1b[5~".to_vec()));
        assert_eq!(encode_key("delete", None, KeyMods::default(), false), Some(b"\x1b[3~".to_vec()));
        assert_eq!(encode_key("f1", None, KeyMods::default(), false), Some(b"\x1bOP".to_vec()));
        assert_eq!(encode_key("f5", None, KeyMods::default(), false), Some(b"\x1b[15~".to_vec()));
        assert_eq!(encode_key("f12", None, KeyMods::default(), false), Some(b"\x1b[24~".to_vec()));
    }

    #[test]
    fn cmd_is_not_sent() {
        let cmd = KeyMods {
            cmd: true,
            ..Default::default()
        };
        assert_eq!(encode_key("c", Some("c"), cmd, false), None);
        assert_eq!(encode_key("v", Some("v"), cmd, false), None);
    }
}
