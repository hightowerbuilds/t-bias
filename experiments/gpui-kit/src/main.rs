//! Phase 0 only: a separate GPUI process, with no application database or PTY.
mod acceptance;
mod terminal_canvas;

use gpui_kit::{
    component::{
        ActiveTheme, IconName, Root, Theme, ThemeMode,
        button::{Button, ButtonVariants},
        input::{
            Copy, Input, InputEvent, InputState, Paste, Redo, SelectAll, Textarea, TextareaState,
            Undo,
        },
    },
    prelude::*,
    *,
};
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

struct Probe {
    search: Entity<InputState>,
    prompt: Entity<TextareaState>,
    _events: Vec<Subscription>,
    changes: usize,
    clicks: usize,
    dark: bool,
    first_paint: Rc<Cell<bool>>,
    started: Instant,
    scroll: ScrollHandle,
    search_bounds: Rc<Cell<Bounds<Pixels>>>,
    prompt_bounds: Rc<Cell<Bounds<Pixels>>>,
    button_bounds: Rc<Cell<Bounds<Pixels>>>,
    last_display: Option<(f32, Size<Pixels>)>,
}
impl Probe {
    fn new(window: &mut Window, cx: &mut Context<Self>, started: Instant) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search / Unicode input"));
        let prompt = cx.new(|cx| TextareaState::new(window,cx).default_value(
            "A multiline prompt.\n中文 · café · e\u{301} · 🦀\nTry selection, undo, paste, and your input method."
        ));
        if std::env::args().any(|a| a == "--long") {
            prompt.update(cx, |s, cx| {
                s.set_value(acceptance::long_prompt(), window, cx)
            });
        }
        let events = vec![
            cx.subscribe(&search, |this, _, event, cx| {
                if matches!(event, InputEvent::Change) {
                    this.changes += 1;
                    cx.notify();
                }
            }),
            cx.subscribe(&prompt, |this, _, event, cx| {
                if matches!(event, InputEvent::Change) {
                    this.changes += 1;
                    cx.notify();
                }
            }),
        ];
        Self {
            search,
            prompt,
            _events: events,
            changes: 0,
            clicks: 0,
            dark: !std::env::args().any(|a| a == "--light"),
            first_paint: Rc::new(Cell::new(false)),
            started,
            scroll: ScrollHandle::new(),
            search_bounds: Rc::default(),
            prompt_bounds: Rc::default(),
            button_bounds: Rc::default(),
            last_display: None,
        }
    }
    fn smoke(&self, window: &Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this,cx| {
            // Exercise real mounted controls and native clipboard actions. This
            // simulates the input-handler boundary, not a physical OS IME session.
            let mut previous_clipboard = None;
            for step in 0..40 {
                cx.background_executor().timer(Duration::from_millis(400)).await;
                this.update_in(cx,|this,window,cx| {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match step {
                        2 => {
                            previous_clipboard = cx.read_from_clipboard();
                            assert!(this.first_paint.get(), "custom canvas was not painted");
                            this.search.update(cx,|s,cx| {
                                s.focus(window,cx);
                                s.replace_text_in_range(None,"Kit 🦀",window,cx);
                            });
                        }
                        3 => {
                            assert_eq!(this.search.read(cx).value(),"Kit 🦀");
                            this.search.update(cx,|s,cx| s.replace_and_mark_text_in_range(None,"に",Some(1..1),window,cx));
                        }
                        4 => {
                            this.search.update(cx,|s,cx| {
                                assert!(s.marked_text_range(window,cx).is_some());
                                s.replace_text_in_range(None,"日本",window,cx);
                            });
                        }
                        5 => {
                            assert_eq!(this.search.read(cx).value(),"Kit 🦀日本");
                            window.dispatch_action(Box::new(SelectAll),cx);
                        }
                        6 => window.dispatch_action(Box::new(Copy),cx),
                        7 => {
                            assert_eq!(cx.read_from_clipboard().and_then(|c|c.text()).as_deref(),Some("Kit 🦀日本"));
                            this.prompt.update(cx,|s,cx| {s.set_value("",window,cx);s.focus(window,cx);});
                        }
                        8 => window.dispatch_action(Box::new(Paste),cx),
                        9 => {
                            assert_eq!(this.prompt.read(cx).value(),"Kit 🦀日本");
                            assert_eq!(this.search.read(cx).value(),"Kit 🦀日本", "focus leaked input");
                            window.dispatch_action(Box::new(Undo),cx);
                        }
                        10 => {
                            assert_eq!(this.prompt.read(cx).value(),"");
                            window.dispatch_action(Box::new(Redo),cx);
                        }
                        11 => {
                            assert_eq!(this.prompt.read(cx).value(),"Kit 🦀日本");
                            this.prompt.update(cx,|s,cx| s.replace_text_in_range(None,"\nsecond line e\u{301}",window,cx));
                            window.resize(size(px(640.),px(420.)));
                            Theme::change(ThemeMode::Light,Some(window),cx);
                        }
                        12 => {
                            assert!(this.prompt.read(cx).value().contains("\nsecond line e\u{301}"));
                            assert!(this.changes >= 4);
                            this.scroll.set_offset(point(px(0.),px(-260.)));
                            cx.notify();
                        }
                        14 => {
                            window.resize(size(px(980.),px(780.)));
                            this.scroll.set_offset(point(px(0.),px(0.)));
                            Theme::change(ThemeMode::Dark,Some(window),cx);
                        }
                        39 => {
                            if let Some(clipboard) = previous_clipboard.take() {
                                cx.write_to_clipboard(clipboard);
                            } else {
                                cx.write_to_clipboard(ClipboardItem::new_string(String::new()));
                            }
                            eprintln!("KIT_INPUT_SMOKE_OK: mounted input, Unicode, marked-text commit/cancel, clipboard, undo/redo, pointer/Tab focus, long-text wheel/caret scrolling, resize, themes");
                            cx.quit();
                        }
                        16..=38 => this.acceptance_step(step,window,cx),
                        _ => {}
                    }));
                    if result.is_err() {
                        cx.write_to_clipboard(previous_clipboard.take().unwrap_or_else(|| ClipboardItem::new_string(String::new())));
                        eprintln!("KIT_INPUT_SMOKE_FAILED: step {step}; clipboard restored");
                        std::process::exit(1);
                    }
                }).expect("probe window disappeared");
            }
        }).detach();
    }
}
impl Render for Probe {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let display = (window.scale_factor(), window.viewport_size());
        if self.last_display != Some(display) {
            eprintln!("KIT_DISPLAY: scale {} · {:?}", display.0, display.1);
            self.last_display = Some(display);
        }
        let started = self.started;
        let painted = self.first_paint.clone();
        let mut background = cx.theme().background;
        if std::env::args().any(|a| a == "--transparent") {
            background.a = 0.75;
        }
        div().size_full().bg(background).text_color(cx.theme().foreground)
            .child(div().id("probe-scroll").size_full().overflow_y_scroll().track_scroll(&self.scroll)
                .p_6().flex().flex_col().gap_4()
                .child(div().flex_shrink_0().text_2xl().child("GPUI Kit · compatibility lab"))
                .child(div().flex_shrink_0().text_sm().child("Kit 0.6.6 / GPUI pre 0.3.6 · isolated from your terminal and saved data"))
                .child(div().flex_shrink_0().flex().flex_wrap().gap_3()
                    .child(acceptance::measured(self.button_bounds.clone(), Button::new("count").primary().icon(IconName::Check).label(format!("Button presses: {}",self.clicks))
                        .on_click(cx.listener(|this,_,_,cx|{this.clicks+=1;cx.notify();}))))
                    .child(Button::new("theme").label("Light / dark").on_click(cx.listener(|this,_,window,cx| {
                        this.dark=!this.dark;
                        Theme::change(if this.dark {ThemeMode::Dark}else{ThemeMode::Light},Some(window),cx);
                    })))
                    .child(Button::new("size").label("640 × 420 / restore").on_click(|_,window,_| {
                        let small=f32::from(window.viewport_size().width)>700.;
                        window.resize(if small {size(px(640.),px(420.))} else {size(px(980.),px(780.))});
                    })))
                .child(acceptance::measured(self.search_bounds.clone(), Input::new(&self.search).id("search").aria_label("Search probe")))
                .child(acceptance::measured(self.prompt_bounds.clone(), Textarea::new(&self.prompt).h(px(150.)).aria_label("Prompt editing probe")))
                .child(div().flex_shrink_0().text_sm().child(format!("Change events: {} · ⌘A/C/V/Z and IME composition belong to the focused input",self.changes)))
                .child(div().flex_shrink_0().text_lg().child("Terminal cell-rendering fixture"))
                .child(div().flex_shrink_0().h(px(240.)).overflow_hidden().child(terminal_canvas::fixture(move |window| {
                    if !painted.replace(true) {
                        eprintln!("KIT_FIRST_PAINT: {:.1} ms · scale {} · {:?}",started.elapsed().as_secs_f64()*1000.,window.scale_factor(),window.viewport_size());
                    }
                })))
                .child(div().flex_shrink_0().text_sm().child("Inspect: ASCII, CJK, combining marks, emoji, ANSI colors, selection and cursor. This draws Alacritty cells with the app’s shape-line/quad approach; it is not a PTY session."))
                .child(div().flex_shrink_0().text_sm().child("Manual checks: click both inputs, Tab between controls, scroll a long prompt, compose with an OS input method, move between display scales. A passing smoke alone does not prove visible glyphs.")))
    }
}
fn main() {
    let started = Instant::now();
    let smoke = std::env::args().any(|a| a == "--smoke");
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            Theme::change(
                if std::env::args().any(|a| a == "--light") {
                    ThemeMode::Light
                } else {
                    ThemeMode::Dark
                },
                None,
                cx,
            );
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        if std::env::args().any(|a| a == "--compact") {
                            size(px(640.), px(420.))
                        } else {
                            size(px(980.), px(780.))
                        },
                        cx,
                    ))),
                    window_min_size: Some(size(px(640.), px(420.))),
                    window_background: WindowBackgroundAppearance::Transparent,
                    ..Default::default()
                },
                move |window, cx| {
                    window.set_window_title("GPUI Kit compatibility lab");
                    let view = cx.new(|cx| Probe::new(window, cx, started));
                    if smoke {
                        view.update(cx, |view, cx| view.smoke(window, cx));
                    }
                    cx.new(|cx| {
                        let root = Root::new(view, window, cx);
                        if std::env::args().any(|a| a == "--transparent") {
                            // Root normally paints the opaque theme background.
                            // Let the probe's own alpha composite with the desktop.
                            root.bg(gpui_kit::transparent_black())
                        } else {
                            root
                        }
                    })
                },
            )
            .expect("open Kit probe");
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
}
