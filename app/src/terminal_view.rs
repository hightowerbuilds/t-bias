// t-bias — terminal cell rendering (Phase 2).
//
// A GPUI `canvas` element that measures a monospace font, reads the emulator's
// `renderable_content()`, and paints per-cell background rects + glyphs with
// full color/attribute support. GPUI owns glyph shaping and the atlas; we own
// the grid layout, the color model, and cursor/attribute mapping.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, CursorShape, NamedColor};
use gpui::{
    canvas, fill, font, outline, point, px, size, App, BorderStyle, Bounds, Font, FontStyle,
    FontWeight, IntoElement, Pixels, Rgba, SharedString, Styled, StrikethroughStyle, TextRun,
    UnderlineStyle, Window,
};

use crate::terminal::{TerminalHandle, TerminalSize};

/// Terminal cell line spacing as a multiple of the font size.
const LINE_HEIGHT: f32 = 1.3;

/// A terminal color theme: 16 ANSI slots plus defaults. Static for now; Phase 8
/// makes it configurable and lets OSC sequences repaint the live palette.
#[derive(Clone, Copy)]
pub struct Theme {
    pub ansi: [Rgba; 16],
    pub fg: Rgba,
    pub bg: Rgba,
    pub cursor: Rgba,
}

impl Default for Theme {
    fn default() -> Self {
        // GitHub-dark-ish palette; `bg` matches the window background.
        Self {
            ansi: [
                hexrgb(0x484f58), // 0 black
                hexrgb(0xff7b72), // 1 red
                hexrgb(0x3fb950), // 2 green
                hexrgb(0xd29922), // 3 yellow
                hexrgb(0x58a6ff), // 4 blue
                hexrgb(0xbc8cff), // 5 magenta
                hexrgb(0x39c5cf), // 6 cyan
                hexrgb(0xb1bac4), // 7 white
                hexrgb(0x6e7681), // 8 bright black
                hexrgb(0xffa198), // 9 bright red
                hexrgb(0x56d364), // 10 bright green
                hexrgb(0xe3b341), // 11 bright yellow
                hexrgb(0x79c0ff), // 12 bright blue
                hexrgb(0xd2a8ff), // 13 bright magenta
                hexrgb(0x56d4dd), // 14 bright cyan
                hexrgb(0xf0f6fc), // 15 bright white
            ],
            fg: hexrgb(0xe6edf3),
            bg: hexrgb(0x0d1117),
            cursor: hexrgb(0x58a6ff),
        }
    }
}

/// One resolved cell, ready to paint.
#[derive(Clone, Copy)]
struct RenderCell {
    ch: char,
    fg: Rgba,
    bg: Rgba,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    /// The trailing half of a wide (CJK) glyph — no glyph of its own.
    spacer: bool,
}

struct GridMetrics {
    cell_w: Pixels,
    line_h: Pixels,
}

/// Build the terminal grid element. Fills its parent; measures the grid from its
/// own painted bounds and reflows the PTY to match.
pub fn terminal_element(
    handle: TerminalHandle,
    font_family: SharedString,
    font_size: Pixels,
    theme: Theme,
    focused: bool,
) -> impl IntoElement {
    let base_font = font(font_family);

    let prepaint_handle = handle.clone();
    let prepaint_font = base_font.clone();
    canvas(
        move |bounds, window, _cx| {
            let ts = window.text_system();
            let font_id = ts.resolve_font(&prepaint_font);
            let cell_w = ts
                .advance(font_id, font_size, 'm')
                .map(|s| s.width)
                .unwrap_or(font_size * 0.6);
            let line_h = font_size * LINE_HEIGHT;

            let cols = ((bounds.size.width / cell_w).floor() as usize).max(1);
            let rows = ((bounds.size.height / line_h).floor() as usize).max(1);
            prepaint_handle.resize_to(TerminalSize::new(cols, rows));

            GridMetrics { cell_w, line_h }
        },
        move |bounds, metrics, window, cx| {
            paint_grid(
                &handle, &base_font, font_size, &theme, focused, bounds, &metrics, window, cx,
            );
        },
    )
    .size_full()
}

#[allow(clippy::too_many_arguments)]
fn paint_grid(
    handle: &TerminalHandle,
    base_font: &Font,
    font_size: Pixels,
    theme: &Theme,
    focused: bool,
    bounds: Bounds<Pixels>,
    metrics: &GridMetrics,
    window: &mut Window,
    cx: &mut App,
) {
    let cell_w = metrics.cell_w;
    let line_h = metrics.line_h;
    let text_system = window.text_system().clone();

    // Snapshot the grid + cursor, then release the lock before painting.
    let (grid, cols, rows, cursor) = {
        let term = handle.term().lock();
        let cols = term.columns();
        let rows = term.screen_lines();
        let default = RenderCell {
            ch: ' ',
            fg: theme.fg,
            bg: theme.bg,
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            spacer: false,
        };
        let mut grid = vec![vec![default; cols]; rows];

        let content = term.renderable_content();
        for indexed in content.display_iter {
            let line = indexed.point.line.0;
            let col = indexed.point.column.0;
            if line < 0 || line as usize >= rows || col >= cols {
                continue;
            }
            let cell = indexed.cell;
            let flags = cell.flags;
            if flags.contains(Flags::WIDE_CHAR_SPACER)
                || flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
            {
                grid[line as usize][col].spacer = true;
                continue;
            }
            let (fg, bg) = cell_colors(cell.c, cell.fg, cell.bg, flags, theme);
            grid[line as usize][col] = RenderCell {
                ch: cell.c,
                fg,
                bg,
                bold: flags.contains(Flags::BOLD),
                italic: flags.contains(Flags::ITALIC),
                underline: flags.intersects(Flags::ALL_UNDERLINES),
                strike: flags.contains(Flags::STRIKEOUT),
                spacer: false,
            };
        }

        let cursor = content.cursor;
        (grid, cols, rows, cursor)
    };

    // Pass 1: background rects, coalescing runs of the same non-default color.
    for (r, row) in grid.iter().enumerate() {
        let mut c = 0;
        while c < cols {
            let bg = row[c].bg;
            if same(bg, theme.bg) {
                c += 1;
                continue;
            }
            let start = c;
            while c < cols && same(row[c].bg, bg) {
                c += 1;
            }
            let x = bounds.origin.x + start * cell_w;
            let y = bounds.origin.y + r * line_h;
            let w = (c - start) * cell_w;
            window.paint_quad(fill(Bounds::new(point(x, y), size(w, line_h)), bg));
        }
    }

    // Pass 2: glyphs, one shaped line per row.
    for (r, row) in grid.iter().enumerate() {
        let mut text = String::with_capacity(cols);
        let mut runs: Vec<TextRun> = Vec::with_capacity(cols);
        for cell in row.iter() {
            if cell.spacer {
                continue;
            }
            let mut buf = [0u8; 4];
            let s = cell.ch.encode_utf8(&mut buf);
            text.push_str(s);

            let mut f = base_font.clone();
            if cell.bold {
                f.weight = FontWeight::BOLD;
            }
            if cell.italic {
                f.style = FontStyle::Italic;
            }
            runs.push(TextRun {
                len: s.len(),
                font: f,
                color: cell.fg.into(),
                background_color: None,
                underline: cell.underline.then(|| UnderlineStyle {
                    thickness: px(1.),
                    color: None,
                    wavy: false,
                }),
                strikethrough: cell.strike.then(|| StrikethroughStyle {
                    thickness: px(1.),
                    color: None,
                }),
            });
        }
        if text.trim_end().is_empty() {
            continue;
        }
        let shaped = text_system.shape_line(SharedString::from(text), font_size, &runs, None);
        let origin = point(bounds.origin.x, bounds.origin.y + r * line_h);
        let _ = shaped.paint(origin, line_h, window, cx);
    }

    // Cursor: focused → solid block with the glyph inverted; unfocused → hollow.
    if cursor.shape != CursorShape::Hidden {
        let line = cursor.point.line.0;
        let col = cursor.point.column.0;
        if line >= 0 && (line as usize) < rows && col < cols {
            let r = line as usize;
            let x = bounds.origin.x + col * cell_w;
            let y = bounds.origin.y + r * line_h;
            let cell_bounds = Bounds::new(point(x, y), size(cell_w, line_h));
            if focused {
                window.paint_quad(fill(cell_bounds, theme.cursor));
                let cell = grid[r][col];
                if !cell.spacer && cell.ch != ' ' {
                    let mut buf = [0u8; 4];
                    let s = cell.ch.encode_utf8(&mut buf);
                    let run = TextRun {
                        len: s.len(),
                        font: base_font.clone(),
                        color: theme.bg.into(),
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    };
                    let shaped = text_system.shape_line(
                        SharedString::from(s.to_string()),
                        font_size,
                        &[run],
                        None,
                    );
                    let _ = shaped.paint(point(x, y), line_h, window, cx);
                }
            } else {
                window.paint_quad(outline(cell_bounds, theme.cursor, BorderStyle::Solid));
            }
        }
    }
}

/// Resolve a cell's foreground/background to concrete colors, applying the
/// inverse / dim / hidden attributes and bold-is-bright for ANSI colors.
fn cell_colors(
    _ch: char,
    fg: AnsiColor,
    bg: AnsiColor,
    flags: Flags,
    theme: &Theme,
) -> (Rgba, Rgba) {
    let mut fg = resolve(fg, flags, theme, true);
    let mut bg = resolve(bg, flags, theme, false);
    if flags.contains(Flags::INVERSE) {
        std::mem::swap(&mut fg, &mut bg);
    }
    if flags.contains(Flags::DIM) {
        fg = dim(fg);
    }
    if flags.contains(Flags::HIDDEN) {
        fg = bg;
    }
    (fg, bg)
}

fn resolve(color: AnsiColor, flags: Flags, theme: &Theme, is_fg: bool) -> Rgba {
    match color {
        AnsiColor::Spec(rgb) => rgb_u8(rgb.r, rgb.g, rgb.b),
        AnsiColor::Indexed(i) => indexed(i, theme),
        AnsiColor::Named(named) => named_color(named, flags, theme, is_fg),
    }
}

fn named_color(named: NamedColor, flags: Flags, theme: &Theme, is_fg: bool) -> Rgba {
    use NamedColor::*;
    match named {
        Foreground | BrightForeground => theme.fg,
        DimForeground => dim(theme.fg),
        Background => theme.bg,
        Cursor => theme.cursor,
        other => {
            let idx = ansi_index(other);
            // Bold foreground text uses the bright ANSI variant (0-7 -> 8-15).
            let idx = if is_fg && flags.contains(Flags::BOLD) && idx < 8 {
                idx + 8
            } else {
                idx
            };
            theme.ansi[idx]
        }
    }
}

/// Map a named ANSI color (including dim variants) to a 0-15 palette slot.
fn ansi_index(named: NamedColor) -> usize {
    use NamedColor::*;
    match named {
        Black | DimBlack => 0,
        Red | DimRed => 1,
        Green | DimGreen => 2,
        Yellow | DimYellow => 3,
        Blue | DimBlue => 4,
        Magenta | DimMagenta => 5,
        Cyan | DimCyan => 6,
        White | DimWhite => 7,
        BrightBlack => 8,
        BrightRed => 9,
        BrightGreen => 10,
        BrightYellow => 11,
        BrightBlue => 12,
        BrightMagenta => 13,
        BrightCyan => 14,
        BrightWhite => 15,
        _ => 7,
    }
}

/// Resolve a 256-color index: 0-15 ANSI, 16-231 color cube, 232-255 grayscale.
fn indexed(i: u8, theme: &Theme) -> Rgba {
    match i {
        0..=15 => theme.ansi[i as usize],
        16..=231 => {
            const STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];
            let j = (i - 16) as usize;
            rgb_u8(STEPS[j / 36], STEPS[(j % 36) / 6], STEPS[j % 6])
        }
        _ => {
            let l = 8u16.saturating_add((i as u16 - 232) * 10).min(255) as u8;
            rgb_u8(l, l, l)
        }
    }
}

fn dim(c: Rgba) -> Rgba {
    Rgba {
        r: c.r * 0.66,
        g: c.g * 0.66,
        b: c.b * 0.66,
        a: c.a,
    }
}

fn rgb_u8(r: u8, g: u8, b: u8) -> Rgba {
    Rgba {
        r: r as f32 / 255.,
        g: g as f32 / 255.,
        b: b as f32 / 255.,
        a: 1.0,
    }
}

fn hexrgb(hex: u32) -> Rgba {
    rgb_u8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

fn same(a: Rgba, b: Rgba) -> bool {
    a.r == b.r && a.g == b.g && a.b == b.b && a.a == b.a
}
