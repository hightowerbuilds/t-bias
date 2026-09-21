//! Terminal mouse protocol encoding, independent of GPUI.
use crate::input::KeyMods;
use alacritty_terminal::term::TermMode;
pub fn report(
    mode: TermMode,
    button: u8,
    col: usize,
    row: usize,
    released: bool,
    mods: KeyMods,
) -> Option<Vec<u8>> {
    let code =
        button + u8::from(mods.shift) * 4 + u8::from(mods.alt) * 8 + u8::from(mods.ctrl) * 16;
    if mode.contains(TermMode::SGR_MOUSE) {
        return Some(
            format!(
                "\x1b[<{code};{};{}{}",
                col + 1,
                row + 1,
                if released { 'm' } else { 'M' }
            )
            .into_bytes(),
        );
    }
    let code = if released {
        3 + code.saturating_sub(button)
    } else {
        code
    };
    if mode.contains(TermMode::UTF8_MOUSE) {
        if col > 2014 || row > 2014 {
            return None;
        }
        return Some(
            format!(
                "\x1b[M{}{}{}",
                char::from(code + 32),
                char::from_u32((col + 33) as u32)?,
                char::from_u32((row + 33) as u32)?
            )
            .into_bytes(),
        );
    }
    if col > 222 || row > 222 {
        return None;
    }
    Some(vec![
        27,
        b'[',
        b'M',
        code + 32,
        (col + 33) as u8,
        (row + 33) as u8,
    ])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sgr_coordinates_modifiers_release() {
        assert_eq!(
            report(TermMode::SGR_MOUSE, 0, 4, 7, false, KeyMods::default()).unwrap(),
            b"\x1b[<0;5;8M"
        );
        assert_eq!(
            report(
                TermMode::SGR_MOUSE,
                2,
                4,
                7,
                true,
                KeyMods {
                    ctrl: true,
                    ..Default::default()
                }
            )
            .unwrap(),
            b"\x1b[<18;5;8m"
        );
    }
    #[test]
    fn legacy_limits_do_not_wrap() {
        assert!(report(TermMode::empty(), 0, 223, 0, false, KeyMods::default()).is_none());
        assert_eq!(
            report(TermMode::empty(), 0, 0, 0, true, KeyMods::default()).unwrap(),
            vec![27, 91, 77, 35, 33, 33]
        );
    }
}
