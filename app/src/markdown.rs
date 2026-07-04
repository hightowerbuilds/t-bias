// t-bias — markdown parsing + rendering (Phase 7).
//
// Parses markdown into a small block/inline model with `pulldown-cmark`, then
// renders that model as a GPUI element tree (no HTML). Flowing rich text
// (bold/italic/code/links inside a wrapping paragraph) uses `StyledText` with
// per-range `HighlightStyle` overrides. The parser is pure and unit-tested; the
// renderer is visual.

use std::ops::Range;

use gpui::{
    div, prelude::*, px, rgb, AnyElement, ElementId, FontStyle, FontWeight, HighlightStyle,
    SharedString, StrikethroughStyle, StyledText, UnderlineStyle,
};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

// --- Model -----------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text(String),
    Code(String),
    Emph(Vec<Inline>),
    Strong(Vec<Inline>),
    Strike(Vec<Inline>),
    Link { text: Vec<Inline>, url: String },
    SoftBreak,
    HardBreak,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Heading { level: u8, content: Vec<Inline> },
    Paragraph(Vec<Inline>),
    Code { lang: Option<String>, text: String },
    List { ordered: bool, start: u64, items: Vec<Vec<Block>> },
    Quote(Vec<Block>),
    Rule,
    Table { headers: Vec<Vec<Inline>>, rows: Vec<Vec<Vec<Inline>>> },
}

// --- Parser ----------------------------------------------------------------

/// One open container while building the tree from the flat event stream.
enum Frame {
    Root(Vec<Block>),
    Para(Vec<Inline>),
    Heading(u8, Vec<Inline>),
    Quote(Vec<Block>),
    List { ordered: bool, start: u64, items: Vec<Vec<Block>> },
    Item(Vec<Block>),
    Code { lang: Option<String>, text: String },
    Emphasis(Vec<Inline>),
    Strong(Vec<Inline>),
    Strike(Vec<Inline>),
    Link { url: String, text: Vec<Inline> },
    Table {
        headers: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
        in_head: bool,
        cur_row: Vec<Vec<Inline>>,
    },
    Cell(Vec<Inline>),
}

/// Parse markdown source into the block model (GFM tables + strikethrough on).
pub fn parse(src: &str) -> Vec<Block> {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let mut stack: Vec<Frame> = vec![Frame::Root(Vec::new())];

    for event in Parser::new_ext(src, opts) {
        match event {
            Event::Start(tag) => on_start(&mut stack, tag),
            Event::End(end) => on_end(&mut stack, end),
            Event::Text(t) => on_text(&mut stack, t.into_string()),
            Event::Code(t) => push_inline(&mut stack, Inline::Code(t.into_string())),
            Event::SoftBreak => push_inline(&mut stack, Inline::SoftBreak),
            Event::HardBreak => push_inline(&mut stack, Inline::HardBreak),
            Event::Rule => push_block(&mut stack, Block::Rule),
            // Html, math, footnotes, task markers: ignored for now.
            _ => {}
        }
    }

    match stack.pop() {
        Some(Frame::Root(blocks)) => blocks,
        _ => Vec::new(),
    }
}

fn heading_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn on_start(stack: &mut Vec<Frame>, tag: Tag) {
    match tag {
        Tag::Paragraph => stack.push(Frame::Para(Vec::new())),
        Tag::Heading { level, .. } => stack.push(Frame::Heading(heading_u8(level), Vec::new())),
        Tag::BlockQuote(_) => stack.push(Frame::Quote(Vec::new())),
        Tag::CodeBlock(kind) => {
            let lang = match kind {
                CodeBlockKind::Fenced(s) if !s.is_empty() => Some(s.into_string()),
                _ => None,
            };
            stack.push(Frame::Code {
                lang,
                text: String::new(),
            });
        }
        Tag::List(start) => stack.push(Frame::List {
            ordered: start.is_some(),
            start: start.unwrap_or(1),
            items: Vec::new(),
        }),
        Tag::Item => stack.push(Frame::Item(Vec::new())),
        Tag::Emphasis => stack.push(Frame::Emphasis(Vec::new())),
        Tag::Strong => stack.push(Frame::Strong(Vec::new())),
        Tag::Strikethrough => stack.push(Frame::Strike(Vec::new())),
        Tag::Link { dest_url, .. } => stack.push(Frame::Link {
            url: dest_url.into_string(),
            text: Vec::new(),
        }),
        // Images render as a link to their destination (alt text as the label).
        Tag::Image { dest_url, .. } => stack.push(Frame::Link {
            url: dest_url.into_string(),
            text: Vec::new(),
        }),
        Tag::Table(_) => stack.push(Frame::Table {
            headers: Vec::new(),
            rows: Vec::new(),
            in_head: false,
            cur_row: Vec::new(),
        }),
        Tag::TableHead => set_table_head(stack, true),
        Tag::TableRow => reset_table_row(stack),
        Tag::TableCell => stack.push(Frame::Cell(Vec::new())),
        _ => {}
    }
}

fn on_end(stack: &mut Vec<Frame>, end: TagEnd) {
    match end {
        TagEnd::Paragraph => {
            if let Some(Frame::Para(v)) = stack.pop() {
                push_block(stack, Block::Paragraph(v));
            }
        }
        TagEnd::Heading(_) => {
            if let Some(Frame::Heading(level, content)) = stack.pop() {
                push_block(stack, Block::Heading { level, content });
            }
        }
        TagEnd::BlockQuote(_) => {
            if let Some(Frame::Quote(v)) = stack.pop() {
                push_block(stack, Block::Quote(v));
            }
        }
        TagEnd::CodeBlock => {
            if let Some(Frame::Code { lang, mut text }) = stack.pop() {
                if text.ends_with('\n') {
                    text.pop();
                }
                push_block(stack, Block::Code { lang, text });
            }
        }
        TagEnd::List(_) => {
            if let Some(Frame::List {
                ordered,
                start,
                items,
            }) = stack.pop()
            {
                push_block(
                    stack,
                    Block::List {
                        ordered,
                        start,
                        items,
                    },
                );
            }
        }
        TagEnd::Item => {
            if let Some(Frame::Item(blocks)) = stack.pop() {
                if let Some(Frame::List { items, .. }) = stack.last_mut() {
                    items.push(blocks);
                }
            }
        }
        TagEnd::Emphasis => {
            if let Some(Frame::Emphasis(v)) = stack.pop() {
                push_inline(stack, Inline::Emph(v));
            }
        }
        TagEnd::Strong => {
            if let Some(Frame::Strong(v)) = stack.pop() {
                push_inline(stack, Inline::Strong(v));
            }
        }
        TagEnd::Strikethrough => {
            if let Some(Frame::Strike(v)) = stack.pop() {
                push_inline(stack, Inline::Strike(v));
            }
        }
        TagEnd::Link | TagEnd::Image => {
            if let Some(Frame::Link { url, text }) = stack.pop() {
                push_inline(stack, Inline::Link { text, url });
            }
        }
        TagEnd::TableCell => {
            if let Some(Frame::Cell(v)) = stack.pop() {
                if let Some(Frame::Table { cur_row, .. }) = stack.last_mut() {
                    cur_row.push(v);
                }
            }
        }
        TagEnd::TableRow => {
            if let Some(Frame::Table {
                in_head,
                cur_row,
                headers,
                rows,
            }) = stack.last_mut()
            {
                let row = std::mem::take(cur_row);
                if *in_head {
                    *headers = row;
                } else {
                    rows.push(row);
                }
            }
        }
        TagEnd::TableHead => {
            // Header cells are direct children of TableHead (no TableRow), so the
            // accumulated `cur_row` becomes the header row here.
            if let Some(Frame::Table {
                in_head,
                cur_row,
                headers,
                ..
            }) = stack.last_mut()
            {
                *headers = std::mem::take(cur_row);
                *in_head = false;
            }
        }
        TagEnd::Table => {
            if let Some(Frame::Table {
                headers, rows, ..
            }) = stack.pop()
            {
                push_block(stack, Block::Table { headers, rows });
            }
        }
        _ => {}
    }
}

fn set_table_head(stack: &mut [Frame], value: bool) {
    if let Some(Frame::Table { in_head, .. }) = stack.last_mut() {
        *in_head = value;
    }
}

fn reset_table_row(stack: &mut [Frame]) {
    if let Some(Frame::Table { cur_row, .. }) = stack.last_mut() {
        cur_row.clear();
    }
}

fn on_text(stack: &mut Vec<Frame>, text: String) {
    // Inside a code block, text is literal content; elsewhere it's an inline.
    if let Some(Frame::Code { text: code, .. }) = stack.last_mut() {
        code.push_str(&text);
    } else {
        push_inline(stack, Inline::Text(text));
    }
}

fn push_inline(stack: &mut [Frame], inline: Inline) {
    if let Some(frame) = stack.last_mut() {
        match frame {
            Frame::Para(v)
            | Frame::Heading(_, v)
            | Frame::Emphasis(v)
            | Frame::Strong(v)
            | Frame::Strike(v)
            | Frame::Link { text: v, .. }
            | Frame::Cell(v) => v.push(inline),
            _ => {}
        }
    }
}

fn push_block(stack: &mut [Frame], block: Block) {
    if let Some(frame) = stack.last_mut() {
        match frame {
            Frame::Root(v) | Frame::Quote(v) | Frame::Item(v) => v.push(block),
            _ => {}
        }
    }
}

// --- Rendering -------------------------------------------------------------

const FG: u32 = 0xc9d1d9;
const HEADING: u32 = 0xf0f6fc;
const MUTED: u32 = 0x8b949e;
const LINK: u32 = 0x58a6ff;
const CODE_FG: u32 = 0xff7b72;
const CODE_BG: u32 = 0x161b22;
const BORDER: u32 = 0x30363d;
const PROSE_FONT: &str = "Helvetica Neue";
const MONO_FONT: &str = "Menlo";

/// Render parsed markdown as a scrollable GPUI element at `font_size` px.
pub fn markdown_element(blocks: &[Block], font_size: f32) -> AnyElement {
    let mut col = div()
        .id("md-doc")
        .flex()
        .flex_col()
        .gap(px(font_size * 0.5))
        .size_full()
        .overflow_y_scroll()
        .px_1()
        .py_3()
        .font_family(PROSE_FONT)
        .text_size(px(font_size))
        .text_color(rgb(FG))
        .line_height(px(font_size * 1.35));
    for block in blocks {
        col = col.child(render_block(block, font_size));
    }
    col.into_any_element()
}

fn render_block(block: &Block, fs: f32) -> AnyElement {
    match block {
        Block::Heading { level, content } => {
            let scale = match level {
                1 => 1.9,
                2 => 1.5,
                3 => 1.25,
                4 => 1.1,
                5 => 1.0,
                _ => 0.9,
            };
            div()
                .text_size(px(fs * scale))
                .line_height(px(fs * scale * 1.2))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(HEADING))
                .child(inline_text(content, ("h", *level as usize)))
                .into_any_element()
        }
        Block::Paragraph(inlines) => div()
            .child(inline_text(inlines, "p"))
            .into_any_element(),
        Block::Code { text, .. } => {
            let mut code = div()
                .flex()
                .flex_col()
                .font_family(MONO_FONT)
                .text_size(px(fs * 0.9))
                .text_color(rgb(FG))
                .bg(rgb(CODE_BG))
                .rounded_md()
                .px_3()
                .py_2()
                .line_height(px(fs * 1.3));
            for line in text.split('\n') {
                let shown = if line.is_empty() { "\u{00a0}" } else { line };
                code = code.child(div().child(shown.to_string()));
            }
            code.into_any_element()
        }
        Block::List {
            ordered,
            start,
            items,
        } => {
            let mut list = div().flex().flex_col().gap_1();
            for (i, item) in items.iter().enumerate() {
                let marker = if *ordered {
                    format!("{}.", start + i as u64)
                } else {
                    "•".to_string()
                };
                let mut item_col = div().flex().flex_col().gap_1().flex_1();
                for b in item {
                    item_col = item_col.child(render_block(b, fs));
                }
                list = list.child(
                    div()
                        .flex()
                        .flex_row()
                        .gap_2()
                        .child(div().flex_none().text_color(rgb(MUTED)).child(marker))
                        .child(item_col),
                );
            }
            list.into_any_element()
        }
        Block::Quote(blocks) => {
            let mut quote = div()
                .flex()
                .flex_col()
                .gap_2()
                .border_l_2()
                .border_color(rgb(BORDER))
                .pl_3()
                .text_color(rgb(MUTED));
            for b in blocks {
                quote = quote.child(render_block(b, fs));
            }
            quote.into_any_element()
        }
        Block::Rule => div()
            .h(px(1.))
            .w_full()
            .bg(rgb(BORDER))
            .into_any_element(),
        Block::Table { headers, rows } => render_table(headers, rows, fs),
    }
}

fn render_table(headers: &[Vec<Inline>], rows: &[Vec<Vec<Inline>>], _fs: f32) -> AnyElement {
    let cell = |content: &[Inline], id: (&'static str, usize), bold: bool| {
        let mut c = div()
            .flex_1()
            .px_2()
            .py_1()
            .border_1()
            .border_color(rgb(BORDER));
        if bold {
            c = c.font_weight(FontWeight::BOLD).text_color(rgb(HEADING));
        }
        c.child(inline_text(content, id)).into_any_element()
    };

    let mut table = div().flex().flex_col();
    if !headers.is_empty() {
        let mut hrow = div().flex().flex_row().bg(rgb(CODE_BG));
        for (i, h) in headers.iter().enumerate() {
            hrow = hrow.child(cell(h, ("th", i), true));
        }
        table = table.child(hrow);
    }
    for (r, row) in rows.iter().enumerate() {
        let mut trow = div().flex().flex_row();
        for (c, content) in row.iter().enumerate() {
            trow = trow.child(cell(content, ("td", r * 64 + c), false));
        }
        table = table.child(trow);
    }
    table.into_any_element()
}

/// Flowing text with per-range styling for inline emphasis/code/links.
fn inline_text(inlines: &[Inline], id: impl Into<ElementId>) -> AnyElement {
    let mut text = String::new();
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    flatten(inlines, HighlightStyle::default(), &mut text, &mut highlights);
    let _ = id; // StyledText is not stateful; id kept for call-site clarity
    StyledText::new(SharedString::from(text))
        .with_highlights(highlights)
        .into_any_element()
}

fn flatten(
    inlines: &[Inline],
    base: HighlightStyle,
    out: &mut String,
    hl: &mut Vec<(Range<usize>, HighlightStyle)>,
) {
    for inline in inlines {
        match inline {
            Inline::Text(t) => {
                let start = out.len();
                out.push_str(t);
                hl.push((start..out.len(), base));
            }
            Inline::Code(t) => {
                let start = out.len();
                out.push_str(t);
                let mut style = base;
                style.color = Some(rgb(CODE_FG).into());
                style.background_color = Some(rgb(CODE_BG).into());
                hl.push((start..out.len(), style));
            }
            Inline::Emph(v) => {
                let mut style = base;
                style.font_style = Some(FontStyle::Italic);
                flatten(v, style, out, hl);
            }
            Inline::Strong(v) => {
                let mut style = base;
                style.font_weight = Some(FontWeight::BOLD);
                flatten(v, style, out, hl);
            }
            Inline::Strike(v) => {
                let mut style = base;
                style.strikethrough = Some(StrikethroughStyle {
                    thickness: px(1.),
                    color: None,
                });
                flatten(v, style, out, hl);
            }
            Inline::Link { text, .. } => {
                let mut style = base;
                style.color = Some(rgb(LINK).into());
                style.underline = Some(UnderlineStyle {
                    thickness: px(1.),
                    color: None,
                    wavy: false,
                });
                flatten(text, style, out, hl);
            }
            Inline::SoftBreak => out.push(' '),
            Inline::HardBreak => out.push('\n'),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Inline {
        Inline::Text(s.to_string())
    }

    #[test]
    fn headings_and_paragraphs() {
        let blocks = parse("# Title\n\nHello world.");
        assert_eq!(
            blocks,
            vec![
                Block::Heading {
                    level: 1,
                    content: vec![text("Title")]
                },
                Block::Paragraph(vec![text("Hello world.")]),
            ]
        );
    }

    #[test]
    fn inline_emphasis_and_code() {
        let blocks = parse("a **b** *c* `d`");
        let Block::Paragraph(inlines) = &blocks[0] else {
            panic!("expected paragraph");
        };
        assert_eq!(inlines[0], text("a "));
        assert_eq!(inlines[1], Inline::Strong(vec![text("b")]));
        assert_eq!(inlines[3], Inline::Emph(vec![text("c")]));
        assert_eq!(inlines[5], Inline::Code("d".into()));
    }

    #[test]
    fn fenced_code_block_keeps_lang_and_text() {
        let blocks = parse("```rust\nlet x = 1;\nlet y = 2;\n```");
        assert_eq!(
            blocks,
            vec![Block::Code {
                lang: Some("rust".into()),
                text: "let x = 1;\nlet y = 2;".into(),
            }]
        );
    }

    #[test]
    fn nested_list() {
        let blocks = parse("- a\n- b\n  - c");
        let Block::List { ordered, items, .. } = &blocks[0] else {
            panic!("expected list");
        };
        assert!(!ordered);
        assert_eq!(items.len(), 2);
        // Second item contains a paragraph and a nested list.
        assert!(items[1]
            .iter()
            .any(|b| matches!(b, Block::List { .. })));
    }

    #[test]
    fn links_and_strikethrough() {
        let blocks = parse("[gpui](https://gpui.rs) ~~gone~~");
        let Block::Paragraph(inlines) = &blocks[0] else {
            panic!("expected paragraph");
        };
        assert_eq!(
            inlines[0],
            Inline::Link {
                text: vec![text("gpui")],
                url: "https://gpui.rs".into()
            }
        );
        assert_eq!(inlines[2], Inline::Strike(vec![text("gone")]));
    }

    #[test]
    fn gfm_table() {
        let blocks = parse("| a | b |\n|---|---|\n| 1 | 2 |");
        let Block::Table { headers, rows } = &blocks[0] else {
            panic!("expected table");
        };
        assert_eq!(headers, &vec![vec![text("a")], vec![text("b")]]);
        assert_eq!(rows, &vec![vec![vec![text("1")], vec![text("2")]]]);
    }

    #[test]
    fn blockquote() {
        let blocks = parse("> quoted");
        assert_eq!(
            blocks,
            vec![Block::Quote(vec![Block::Paragraph(vec![text("quoted")])])]
        );
    }
}
