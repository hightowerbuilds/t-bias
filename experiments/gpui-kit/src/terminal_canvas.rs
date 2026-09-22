//! Reduced fixture of app/src/terminal_view.rs's two-pass quad/shape_line path.
//! Deliberately not a second production terminal implementation.
use alacritty_terminal::{
    event::{Event, EventListener},
    grid::Dimensions,
    index::{Column, Line, Point as TerminalPoint, Side},
    selection::{Selection, SelectionType},
    term::{Config, Term, cell::Flags},
    vte::ansi::{Color, NamedColor, Processor, StdSyncHandler},
};
use gpui_kit::{prelude::*, *};
struct GridSize;
impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        8
    }
    fn screen_lines(&self) -> usize {
        8
    }
    fn columns(&self) -> usize {
        76
    }
}
#[derive(Clone)]
struct Listener;
impl EventListener for Listener {
    fn send_event(&self, _: Event) {}
}

fn color(c: Color, foreground: bool) -> Rgba {
    const ANSI: [u32; 16] = [
        0x18212b, 0xf07178, 0xc3e88d, 0xffcb6b, 0x82aaff, 0xc792ea, 0x89ddff, 0xe6edf3, 0x546e7a,
        0xff8a80, 0xccff90, 0xffe57f, 0x82b1ff, 0xea80fc, 0x84ffff, 0xffffff,
    ];
    match c {
        Color::Spec(c) => rgb((c.r as u32) << 16 | (c.g as u32) << 8 | c.b as u32),
        Color::Indexed(i) if i < 16 => rgb(ANSI[i as usize]),
        Color::Named(n) if (n as usize) < 16 => rgb(ANSI[n as usize]),
        Color::Named(NamedColor::Background) => rgb(0x0b1117),
        _ => rgb(if foreground { 0xe6edf3 } else { 0x0b1117 }),
    }
}
pub fn fixture(first_paint: impl Fn(&Window) + 'static) -> impl IntoElement {
    let mut term = Term::new(Config::default(), &GridSize, Listener);
    let mut processor: Processor<StdSyncHandler> = Processor::new();
    processor.advance(&mut term,concat!(
        "ASCII    The quick brown fox 0123456789  [ ] { } < >\r\n",
        "CJK      中文 日本語 한글\r\n",
        "Marks    cafe\u{301}  nai\u{308}ve  a\u{30a}\r\n",
        "Emoji    🦀 🚀 😀\r\n",
        "ANSI     \x1b[31mred \x1b[32mgreen \x1b[34mblue \x1b[1;35mbold\x1b[0m \x1b[4munderline\x1b[0m\r\n",
        "Select   highlighted terminal cells\r\n",
        "Cursor   > "
    ).as_bytes());
    let mut selection = Selection::new(
        SelectionType::Simple,
        TerminalPoint::new(Line(5), Column(9)),
        Side::Left,
    );
    selection.update(TerminalPoint::new(Line(5), Column(19)), Side::Right);
    term.selection = Some(selection);
    canvas(
        |bounds, _, _| bounds,
        move |_, bounds, window, cx| {
            first_paint(window);
            let base = font("Menlo");
            let font_size = px(15.);
            let line_height = px(28.);
            let cell_width = window
                .text_system()
                .advance(window.text_system().resolve_font(&base), font_size, 'm')
                .unwrap()
                .width;
            window.paint_quad(fill(bounds, rgb(0x0b1117)));
            let content = term.renderable_content();
            let mut rows = vec![(String::new(), Vec::<TextRun>::new()); 8];
            for indexed in content.display_iter {
                let row = indexed.point.line.0 as usize;
                let col = indexed.point.column.0;
                if row >= rows.len() {
                    continue;
                }
                let cell = indexed.cell;
                let selected = content
                    .selection
                    .as_ref()
                    .is_some_and(|s| s.contains(indexed.point));
                let bg = if selected {
                    rgb(0x385b85)
                } else {
                    color(cell.bg, false)
                };
                window.paint_quad(fill(
                    Bounds::new(
                        point(
                            bounds.origin.x + px(12.) + col * cell_width,
                            bounds.origin.y + px(8.) + row * line_height,
                        ),
                        size(cell_width, line_height),
                    ),
                    bg,
                ));
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let mut text = cell.c.to_string();
                text.extend(cell.zerowidth().unwrap_or(&[]));
                let mut font = base.clone();
                if cell.flags.contains(Flags::BOLD) {
                    font.weight = FontWeight::BOLD;
                }
                rows[row].1.push(TextRun {
                    len: text.len(),
                    font,
                    color: color(cell.fg, true).into(),
                    background_color: None,
                    underline: cell.flags.intersects(Flags::ALL_UNDERLINES).then(|| {
                        UnderlineStyle {
                            thickness: px(1.),
                            color: None,
                            wavy: false,
                        }
                    }),
                    strikethrough: None,
                });
                rows[row].0.push_str(&text);
            }
            for (row, (text, runs)) in rows.into_iter().enumerate() {
                let shaped = window
                    .text_system()
                    .shape_line(text.into(), font_size, &runs, None);
                shaped
                    .paint(
                        point(
                            bounds.origin.x + px(12.),
                            bounds.origin.y + px(8.) + row * line_height,
                        ),
                        line_height,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    )
                    .expect("paint terminal row");
            }
            let cursor = content.cursor.point;
            window.paint_quad(fill(
                Bounds::new(
                    point(
                        bounds.origin.x + px(12.) + cursor.column.0 * cell_width,
                        bounds.origin.y + px(8.) + cursor.line.0 as usize * line_height,
                    ),
                    size(cell_width, line_height),
                ),
                rgb(0x89ddff),
            ));
        },
    )
    .size_full()
}
