//! Small native text editor used by the prompt library. Indices are UTF-16 for macOS IME.
use std::{cell::RefCell, ops::Range, rc::Rc};
#[derive(Default)]
struct FieldLayout {
    bounds: Option<Bounds<Pixels>>,
    lines: Vec<gpui::ShapedLine>,
}
use gpui::{
    div, prelude::*, px, rgb, Bounds, Context, EntityInputHandler, FocusHandle, KeyDownEvent,
    MouseButton, Pixels, Point, UTF16Selection, Window,
};
pub struct TextField {
    pub text: String,
    pub focus: FocusHandle,
    pub multiline: bool,
    placeholder: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    layout: Rc<RefCell<FieldLayout>>,
    anchor: usize,
}
impl TextField {
    pub fn new(placeholder: &str, multiline: bool, cx: &mut Context<Self>) -> Self {
        Self {
            text: String::new(),
            focus: cx.focus_handle(),
            multiline,
            placeholder: placeholder.into(),
            selection: 0..0,
            marked: None,
            layout: Rc::new(RefCell::new(FieldLayout::default())),
            anchor: 0,
        }
    }
    pub fn set_text(&mut self, text: String, cx: &mut Context<Self>) {
        self.text = text;
        let n = self.text.encode_utf16().count();
        self.selection = n..n;
        self.marked = None;
        cx.notify();
    }
    fn replace(&mut self, range: Option<Range<usize>>, text: &str, cx: &mut Context<Self>) {
        let mut chars: Vec<u16> = self.text.encode_utf16().collect();
        let r = range
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let start = r.start.min(chars.len());
        let end = r.end.min(chars.len()).max(start);
        let text = if self.multiline {
            text.to_string()
        } else {
            text.replace(['\r', '\n'], " ")
        };
        chars.splice(start..end, text.encode_utf16());
        self.text = String::from_utf16_lossy(&chars);
        let end = start + text.encode_utf16().count();
        self.selection = end..end;
        self.marked = None;
        cx.notify();
    }
    fn boundary(&self, index: usize, forward: bool) -> usize {
        let mut offset = 0;
        let mut previous = 0;
        for c in self.text.chars() {
            offset += c.len_utf16();
            if forward && offset > index {
                return offset;
            }
            if !forward && offset >= index {
                return previous;
            }
            previous = offset;
        }
        if forward {
            offset
        } else {
            previous
        }
    }
    fn key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let k = &event.keystroke;
        let n = self.text.encode_utf16().count();
        if k.modifiers.platform {
            match k.key.as_str() {
                "a" => self.selection = 0..n,
                "c" | "x" => {
                    let chars: Vec<u16> = self.text.encode_utf16().collect();
                    let text = String::from_utf16_lossy(&chars[self.selection.clone()]);
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                    if k.key == "x" {
                        self.replace(None, "", cx);
                    }
                }
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                        self.replace(None, &text, cx);
                    }
                }
                _ => return,
            }
        } else {
            if self.marked.is_some() {
                return;
            }
            match k.key.as_str() {
                "backspace" => {
                    if self.selection.is_empty() {
                        self.selection.start = self.boundary(self.selection.start, false);
                    }
                    self.replace(None, "", cx);
                }
                "delete" => {
                    if self.selection.is_empty() {
                        self.selection.end = self.boundary(self.selection.end, true);
                    }
                    self.replace(None, "", cx);
                }
                "left" | "right" => {
                    let forward = k.key == "right";
                    let edge = if forward {
                        self.selection.end
                    } else {
                        self.selection.start
                    };
                    let next = self.boundary(edge, forward);
                    if k.modifiers.shift {
                        if forward {
                            self.selection.end = next;
                        } else {
                            self.selection.start = next;
                        }
                    } else {
                        self.selection = next..next;
                    }
                }
                "home" => self.selection = 0..0,
                "end" => self.selection = n..n,
                "enter" if self.multiline => self.replace(None, "\n", cx),
                "tab" if self.multiline => self.replace(None, "    ", cx),
                _ => return,
            }
        }
        cx.stop_propagation();
        cx.notify();
    }
}
impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let v: Vec<u16> = self.text.encode_utf16().collect();
        let r = r.start.min(v.len())..r.end.min(v.len());
        *actual = Some(r.clone());
        String::from_utf16(&v[r]).ok()
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.selection.clone(),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone()
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace(r, text, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let start = r
            .as_ref()
            .or(self.marked.as_ref())
            .unwrap_or(&self.selection)
            .start;
        self.replace(r, text, cx);
        let end = self.selection.end;
        self.marked = (!text.is_empty()).then_some(start..end);
        if let Some(s) = selected {
            self.selection = (start + s.start).min(end)..(start + s.end).min(end);
        }
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(bounds)
    }
    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.index_at(p))
    }
}
fn utf8_at_utf16(text: &str, index: usize) -> usize {
    let mut utf16 = 0;
    for (byte, c) in text.char_indices() {
        if utf16 >= index {
            return byte;
        }
        utf16 += c.len_utf16();
    }
    text.len()
}
impl TextField {
    fn index_at(&self, position: Point<Pixels>) -> usize {
        let layout = self.layout.borrow();
        let Some(bounds) = layout.bounds else {
            return 0;
        };
        let row = ((f32::from(position.y - bounds.origin.y) / 22.)
            .floor()
            .max(0.) as usize)
            .min(layout.lines.len().saturating_sub(1));
        let Some(line) = layout.lines.get(row) else {
            return 0;
        };
        let byte = line.closest_index_for_x(position.x - bounds.origin.x);
        let prefix: usize = self
            .text
            .split('\n')
            .take(row)
            .map(|s| s.encode_utf16().count() + 1)
            .sum();
        (prefix + line.text[..byte].encode_utf16().count()).min(self.text.encode_utf16().count())
    }
}
impl Render for TextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        let entity = cx.entity();
        let focus = self.focus.clone();
        let empty = self.text.is_empty();
        let display = if empty {
            self.placeholder.clone()
        } else {
            self.text.clone()
        };
        let line_count = display.split('\n').count();
        let content_width = display
            .split('\n')
            .map(|l| {
                l.chars()
                    .map(|c| if c.is_ascii() { 8.5 } else { 17. })
                    .sum::<f32>()
            })
            .fold(0., f32::max);
        let selection = self.selection.clone();
        let marked = self.marked.clone();
        let layout = self.layout.clone();
        let canvas = gpui::canvas(
            move |_, window, _| {
                display
                    .split('\n')
                    .map(|text| {
                        let run = gpui::TextRun {
                            len: text.len(),
                            font: gpui::font("Menlo"),
                            color: if empty {
                                rgb(0x6e7681).into()
                            } else {
                                rgb(0xe6edf3).into()
                            },
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        window.text_system().shape_line(
                            text.to_string().into(),
                            px(14.),
                            &[run],
                            None,
                        )
                    })
                    .collect::<Vec<_>>()
            },
            move |bounds, lines, window, cx| {
                window.handle_input(
                    &focus,
                    gpui::ElementInputHandler::new(bounds, entity.clone()),
                    cx,
                );
                let mut offset = 0;
                for (row, line) in lines.iter().enumerate() {
                    let origin = gpui::point(bounds.origin.x, bounds.origin.y + row * px(22.));
                    let len = if empty {
                        0
                    } else {
                        line.text.encode_utf16().count()
                    };
                    let start = selection.start.saturating_sub(offset).min(len);
                    let end = selection.end.saturating_sub(offset).min(len);
                    if !empty && start < end {
                        let x1 = line.x_for_index(utf8_at_utf16(&line.text, start));
                        let x2 = line.x_for_index(utf8_at_utf16(&line.text, end));
                        window.paint_quad(gpui::fill(
                            Bounds::new(
                                gpui::point(origin.x + x1, origin.y),
                                gpui::size(x2 - x1, px(22.)),
                            ),
                            rgb(0x385b85),
                        ));
                    }
                    let _ = line.paint(origin, px(22.), window, cx);
                    if focused
                        && selection.is_empty()
                        && selection.end >= offset
                        && selection.end <= offset + len
                    {
                        let x = if empty {
                            px(0.)
                        } else {
                            line.x_for_index(utf8_at_utf16(&line.text, selection.end - offset))
                        };
                        window.paint_quad(gpui::fill(
                            Bounds::new(
                                gpui::point(origin.x + x, origin.y),
                                gpui::size(px(1.), px(20.)),
                            ),
                            rgb(0x58a6ff),
                        ));
                    }
                    if let Some(mark) = &marked {
                        let a = mark.start.saturating_sub(offset).min(len);
                        let b = mark.end.saturating_sub(offset).min(len);
                        if a < b {
                            let x1 = line.x_for_index(utf8_at_utf16(&line.text, a));
                            let x2 = line.x_for_index(utf8_at_utf16(&line.text, b));
                            window.paint_quad(gpui::fill(
                                Bounds::new(
                                    gpui::point(origin.x + x1, origin.y + px(20.)),
                                    gpui::size(x2 - x1, px(1.)),
                                ),
                                rgb(0x58a6ff),
                            ));
                        }
                    }
                    offset += len + 1;
                }
                *layout.borrow_mut() = FieldLayout {
                    bounds: Some(bounds),
                    lines,
                };
            },
        )
        .w_full()
        .min_w(px(content_width + 4.))
        .h(px(line_count as f32 * 22.));
        div()
            .id("text-field")
            .track_focus(&self.focus)
            .w_full()
            .min_h(px(if self.multiline { 100. } else { 38. }))
            .max_h(px(240.))
            .overflow_scroll()
            .p_2()
            .border_1()
            .rounded_md()
            .border_color(if focused {
                rgb(0x58a6ff)
            } else {
                rgb(0x30363d)
            })
            .bg(rgb(0x0d1117))
            .on_key_down(cx.listener(Self::key))
            .on_action(cx.listener(|this, _: &crate::menus::Copy, w, cx| {
                this.key(
                    &KeyDownEvent {
                        keystroke: gpui::Keystroke::parse("cmd-c").unwrap(),
                        is_held: false,
                    },
                    w,
                    cx,
                );
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Paste, w, cx| {
                this.key(
                    &KeyDownEvent {
                        keystroke: gpui::Keystroke::parse("cmd-v").unwrap(),
                        is_held: false,
                    },
                    w,
                    cx,
                );
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &gpui::MouseDownEvent, window, cx| {
                    window.focus(&this.focus);
                    let index = this.index_at(e.position);
                    if !e.modifiers.shift {
                        this.anchor = index;
                    }
                    this.selection = this.anchor.min(index)..this.anchor.max(index);
                    cx.stop_propagation();
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, e: &gpui::MouseMoveEvent, _, cx| {
                if e.dragging() {
                    let index = this.index_at(e.position);
                    this.selection = this.anchor.min(index)..this.anchor.max(index);
                    cx.notify();
                }
            }))
            .child(canvas)
    }
}
