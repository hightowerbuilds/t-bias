//! Mounted native-window checks, using GPUI event dispatch. OS IME and physical
//! display transitions are separate: these checks do not emulate either one.
use super::*;

pub fn long_prompt() -> String {
    (0..300)
        .map(|i| {
            format!("Line {i:03}: 中文 · café · e\u{301} · 🦀 — a long prompt remains editable.\n")
        })
        .collect()
}

pub fn measured(bounds: Rc<Cell<Bounds<Pixels>>>, child: impl IntoElement) -> impl IntoElement {
    div()
        .relative()
        .flex_shrink_0()
        .child(
            canvas(move |b, _, _| bounds.set(b), |_, _, _, _| {})
                .absolute()
                .size_full(),
        )
        .child(child)
}

fn key(key: &str, window: &mut Window, cx: &mut App) {
    let key = Keystroke::parse(key).expect("valid fixture keystroke");
    window.defer(cx, move |window, cx| {
        window.dispatch_keystroke(key, cx);
    });
}

fn click(bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    assert!(
        bounds.size.width > px(0.) && bounds.size.height > px(0.),
        "control not laid out"
    );
    let position = bounds.center();
    // A click invokes Probe's button listener. Dispatch after releasing the
    // current entity update to follow the platform event loop's borrow order.
    window.defer(cx, move |window, cx| {
        window.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position,
                click_count: 1,
                ..Default::default()
            }),
            cx,
        );
        window.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position,
                click_count: 1,
                ..Default::default()
            }),
            cx,
        );
    });
}

impl Probe {
    pub(super) fn acceptance_step(
        &mut self,
        step: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match step {
            16 => click(self.button_bounds.get(), window, cx),
            17 => {
                assert_eq!(self.clicks, 1, "pointer button activation");
                click(self.search_bounds.get(), window, cx);
            }
            18 => {
                assert!(
                    self.search.focus_handle(cx).is_focused(window),
                    "pointer search focus"
                );
                key("tab", window, cx);
            }
            19 => {
                assert!(
                    self.prompt.focus_handle(cx).is_focused(window),
                    "Tab search → prompt"
                );
                key("shift-tab", window, cx);
            }
            20 => {
                assert!(
                    self.search.focus_handle(cx).is_focused(window),
                    "Shift-Tab prompt → search"
                );
                click(self.prompt_bounds.get(), window, cx);
            }
            21 => {
                assert!(
                    self.prompt.focus_handle(cx).is_focused(window),
                    "pointer prompt focus"
                );
                self.prompt
                    .update(cx, |s, cx| s.set_value(long_prompt(), window, cx));
            }
            22 => {
                key("cmd-up", window, cx);
            }
            23 => {
                assert_eq!(self.prompt.read(cx).cursor(), 0);
                let position = self.prompt_bounds.get().center();
                window.defer(cx, move |window, cx| {
                    window.dispatch_event(
                        PlatformInput::ScrollWheel(ScrollWheelEvent {
                            position,
                            delta: ScrollDelta::Pixels(point(px(0.), px(-600.))),
                            modifiers: Modifiers::default(),
                            touch_phase: TouchPhase::Moved,
                        }),
                        cx,
                    );
                });
            }
            24 => {
                let prompt = self.prompt.read(cx);
                assert!(
                    prompt.scroll_offset().y < px(-100.),
                    "wheel must scroll the textarea, not just its parent"
                );
                assert!(
                    prompt.visible_row_range().unwrap().start > 0,
                    "long prompt rows must advance"
                );
                assert_eq!(
                    self.scroll.offset().y,
                    px(0.),
                    "textarea wheel leaked into outer scroll"
                );
                key("cmd-down", window, cx);
            }
            25 => {
                let prompt = self.prompt.read(cx);
                assert_eq!(
                    prompt.cursor(),
                    long_prompt().len(),
                    "end-of-document keyboard navigation"
                );
                assert!(
                    prompt.visible_row_range().unwrap().end >= 300,
                    "caret at end must scroll into view"
                );
                key("x", window, cx);
            }
            26 => {
                assert_eq!(
                    self.prompt.read(cx).value().as_ref(),
                    format!("{}x", long_prompt())
                );
                assert_eq!(
                    self.search.read(cx).value(),
                    "Kit 🦀日本",
                    "typed text leaked to search"
                );
                window.resize(size(px(640.), px(420.)));
            }
            27 => {
                assert!(self.prompt.read(cx).scroll_offset().y < px(-100.));
                key("cmd-up", window, cx);
            }
            28 => {
                assert_eq!(self.prompt.read(cx).cursor(), 0);
                assert_eq!(self.prompt.read(cx).visible_row_range().unwrap().start, 0);
                key("cmd-a", window, cx);
            }
            29 => {
                assert_eq!(
                    self.prompt.read(cx).selected_range(),
                    0..long_prompt().len() + 1
                );
                key("cmd-c", window, cx);
            }
            30 => {
                assert_eq!(
                    cx.read_from_clipboard().and_then(|c| c.text()).unwrap(),
                    format!("{}x", long_prompt())
                );
                // Exercise cancellation at the text-input boundary. Actual OS
                // candidate cancellation is deliberately not claimed here.
                self.search.update(cx, |s, cx| {
                    s.focus(window, cx);
                    s.set_value("Keep 🦀", window, cx);
                    s.set_selected_range("Keep 🦀".len().."Keep 🦀".len(), cx);
                    s.replace_and_mark_text_in_range(None, "にほん", Some(3..3), window, cx);
                });
            }
            31 => self.search.update(cx, |s, cx| {
                let range = s.marked_text_range(window, cx).expect("composition range");
                s.replace_text_in_range(Some(range), "", window, cx);
                assert!(s.marked_text_range(window, cx).is_none());
                assert_eq!(s.value(), "Keep 🦀");
            }),
            32 => {
                window.resize(size(px(980.), px(780.)));
                self.scroll.set_offset(point(px(0.), px(0.)));
                Theme::change(ThemeMode::Light, Some(window), cx);
            }
            34 => {
                Theme::change(ThemeMode::Dark, Some(window), cx);
                eprintln!(
                    "KIT_ACCEPTANCE_OK: pointer/Tab focus; 300-line textarea wheel, caret, selection/copy, compact resize; marked-text cancellation boundary"
                );
            }
            _ => {}
        }
    }
}
