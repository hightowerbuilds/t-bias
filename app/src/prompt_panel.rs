use crate::{prompts::Library, ui::button};
use gpui::{div, prelude::*, px, rgb, Context, Entity, EventEmitter, Subscription, Window};
use gpui_kit::component::{
    input::{Input, InputState, Textarea, TextareaState},
    ActiveTheme,
};
pub enum PromptEvent {
    Send(String),
    Close,
}
pub struct PromptPanel {
    focus_requested: bool,
    library: Library,
    conn: Option<rusqlite::Connection>,
    search: Entity<InputState>,
    editor: Entity<TextareaState>,
    tags: Entity<InputState>,
    editing: Option<String>,
    error: Option<String>,
    _search: Subscription,
}
impl EventEmitter<PromptEvent> for PromptPanel {}
impl PromptPanel {
    pub fn focus(&mut self, cx: &mut Context<Self>) {
        self.focus_requested = true;
        cx.notify();
    }
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut error = None;
        let conn = crate::db::default_db_path()
            .and_then(|p| crate::db::open(&p))
            .map_err(|e| error = Some(e.to_string()))
            .ok();
        let library = conn
            .as_ref()
            .and_then(|c| {
                Library::load(c)
                    .map_err(|e| error = Some(e.to_string()))
                    .ok()
            })
            .unwrap_or_default();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search prompts or tags"));
        let editor = cx.new(|cx| TextareaState::new(window, cx).placeholder("Write a prompt…"));
        let tags =
            cx.new(|cx| InputState::new(window, cx).placeholder("Tags, separated by commas"));
        let observer = cx.observe(&search, |_, _, cx| cx.notify());
        Self {
            focus_requested: false,
            library,
            conn,
            search,
            editor,
            tags,
            editing: None,
            error,
            _search: observer,
        }
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        if let Some(c) = &self.conn {
            if let Err(e) = self.library.save(c) {
                self.error = Some(e.to_string());
            }
        } else {
            self.error = Some("Prompt database is unavailable; changes are only in memory".into());
        }
        cx.notify();
    }
    pub fn send_next(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.library.queue.first().cloned() {
            if let Some(prompt) = self.library.prompts.iter().find(|p| p.id == id) {
                cx.emit(PromptEvent::Send(prompt.text.clone()));
                self.library.queue.remove(0);
                self.save(cx);
            }
        }
    }
    fn save_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        let tags: Vec<_> = self
            .tags
            .read(cx)
            .value()
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        if text.trim().is_empty() {
            self.error = Some("Enter a prompt first".into());
            cx.notify();
            return;
        }
        if let Some(id) = self.editing.take() {
            if let Some(p) = self.library.prompts.iter_mut().find(|p| p.id == id) {
                p.text = text;
                p.tags = tags;
            }
        } else if let Err(e) = self.library.add(text, tags) {
            self.error = Some(e.to_string());
            return;
        }
        self.editor.update(cx, |f, cx| f.set_value("", window, cx));
        self.tags.update(cx, |f, cx| f.set_value("", window, cx));
        self.error = None;
        self.save(cx);
    }
    fn import(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Import prompt library".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(path) = paths.first() {
                    let result = std::fs::read_to_string(path)
                        .map_err(anyhow::Error::from)
                        .and_then(|s| Library::parse(&s));
                    let _ = this.update(cx, |this, cx| match result {
                        Ok(library) => {
                            this.library.merge(library);
                            this.save(cx);
                        }
                        Err(e) => {
                            this.error = Some(e.to_string());
                            cx.notify();
                        }
                    });
                }
            }
        })
        .detach();
    }
    fn export(&mut self, cx: &mut Context<Self>) {
        let root = crate::config::data_dir().unwrap_or_default();
        let path = cx.prompt_for_new_path(&root, Some("t-bias-prompts.json"));
        let library = self.library.clone();
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(path))) = path.await {
                let result = serde_json::to_string_pretty(&library)
                    .map_err(anyhow::Error::from)
                    .and_then(|s| std::fs::write(path, s).map_err(Into::into));
                if let Err(e) = result {
                    let _ = this.update(cx, |this, cx| {
                        this.error = Some(e.to_string());
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }
}
impl Render for PromptPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_requested {
            self.focus_requested = false;
            self.search.update(cx, |s, cx| s.focus(window, cx));
        }
        let query = self.search.read(cx).value().to_lowercase();
        let mut queue = div().flex().flex_col().gap_1();
        for (i, id) in self.library.queue.iter().enumerate() {
            if let Some(p) = self.library.prompts.iter().find(|p| &p.id == id) {
                queue = queue.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_1()
                        .child(div().flex_1().child(format!(
                                "{}. {}",
                                i + 1,
                                p.text
                                    .lines()
                                    .next()
                                    .unwrap_or("")
                                    .chars()
                                    .take(35)
                                    .collect::<String>()
                            )))
                        .child(button(("up", i), "↑").on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.library.move_queue(i, -1);
                                this.save(cx);
                            },
                        )))
                        .child(button(("down", i), "↓").on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.library.move_queue(i, 1);
                                this.save(cx);
                            },
                        )))
                        .child(button(("remove", i), "×").on_click(cx.listener(
                            move |this, _, _, cx| {
                                if i < this.library.queue.len() {
                                    this.library.queue.remove(i);
                                }
                                this.save(cx);
                            },
                        ))),
                );
            }
        }
        let mut list = div()
            .id("prompt-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2();
        for (i, p) in self
            .library
            .prompts
            .iter()
            .filter(|p| {
                p.text.to_lowercase().contains(&query) || p.tags.iter().any(|t| t.contains(&query))
            })
            .enumerate()
        {
            let id = p.id.clone();
            let edit = id.clone();
            let delete = id.clone();
            let duplicate = id.clone();
            let send = p.text.clone();
            let tags = p.tags.join(", ");
            list = list.child(
                div()
                    .border_1()
                    .border_color(cx.theme().border)
                    .rounded_md()
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(p.text.chars().take(400).collect::<String>())
                    .child(div().text_color(cx.theme().primary).child(tags))
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .flex_wrap()
                            .child(button(("enqueue", i), "Queue").on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.library.enqueue(&id);
                                    this.save(cx);
                                },
                            )))
                            .child(button(("send", i), "Send").on_click(cx.listener(
                                move |_, _, _, cx| cx.emit(PromptEvent::Send(send.clone())),
                            )))
                            .child(button(("edit", i), "Edit").on_click(cx.listener(
                                move |this, _, window, cx| {
                                    if let Some(p) =
                                        this.library.prompts.iter().find(|p| p.id == edit).cloned()
                                    {
                                        this.editing = Some(edit.clone());
                                        this.editor
                                            .update(cx, |f, cx| f.set_value(p.text, window, cx));
                                        this.tags.update(cx, |f, cx| {
                                            f.set_value(p.tags.join(", "), window, cx)
                                        });
                                        cx.notify();
                                    }
                                },
                            )))
                            .child(button(("duplicate", i), "Copy").on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if let Some(p) = this
                                        .library
                                        .prompts
                                        .iter()
                                        .find(|p| p.id == duplicate)
                                        .cloned()
                                    {
                                        let _ = this.library.add(p.text, p.tags);
                                        this.save(cx);
                                    }
                                },
                            )))
                            .child(button(("delete", i), "Delete").on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.library.delete(&delete);
                                    this.save(cx);
                                },
                            ))),
                    ),
            );
        }
        div()
            .w(px(440.))
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .text_size(px(13.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().child("Prompt library"))
                    .child(
                        button("import", "Import")
                            .on_click(cx.listener(|this, _, _, cx| this.import(cx))),
                    )
                    .child(
                        button("export", "Export")
                            .on_click(cx.listener(|this, _, _, cx| this.export(cx))),
                    )
                    .child(
                        button("close", "×")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(PromptEvent::Close))),
                    ),
            )
            .when_some(self.error.clone(), |d, e| {
                d.child(div().text_color(rgb(0xff7b72)).child(e))
            })
            .child(Input::new(&self.search).aria_label("Search prompts"))
            .child(
                Textarea::new(&self.editor)
                    .h(px(150.))
                    .aria_label("Prompt text"),
            )
            .child(Input::new(&self.tags).aria_label("Prompt tags"))
            .child(
                button(
                    "save",
                    if self.editing.is_some() {
                        "Save changes"
                    } else {
                        "Save prompt"
                    },
                )
                .on_click(cx.listener(|this, _, window, cx| this.save_editor(window, cx))),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        button("next", "Send next  ⌘⇧Q")
                            .on_click(cx.listener(|this, _, _, cx| this.send_next(cx))),
                    )
                    .child(button("clear", "Clear queue").on_click(cx.listener(
                        |this, _, _, cx| {
                            this.library.queue.clear();
                            this.save(cx);
                        },
                    ))),
            )
            .child(
                div()
                    .id("prompt-queue")
                    .max_h(px(100.))
                    .overflow_y_scroll()
                    .child(queue),
            )
            .child(list)
    }
}

impl PromptPanel {
    pub fn kit_smoke(&mut self, phase: usize, window: &mut Window, cx: &mut Context<Self>) {
        use gpui::Focusable;
        match phase {
            0 => {
                self.editor.update(cx, |s, cx| {
                    s.set_value("A draft 中文 🦀\nsecond line", window, cx);
                    s.focus(window, cx);
                });
                self.tags
                    .update(cx, |s, cx| s.set_value("Test, Unicode", window, cx));
            }
            1 => {
                assert!(self.editor.focus_handle(cx).is_focused(window));
                window.defer(cx, |window, cx| {
                    window.dispatch_keystroke(gpui::Keystroke::parse("cmd-down").unwrap(), cx);
                    window.dispatch_keystroke(gpui::Keystroke::parse("x").unwrap(), cx);
                });
            }
            2 => {
                assert!(
                    self.editor.read(cx).value().ends_with('x'),
                    "Kit field did not receive typing"
                );
                self.save_editor(window, cx);
                assert_eq!(self.library.prompts.len(), 1);
                assert_eq!(self.library.prompts[0].tags, vec!["test", "unicode"]);
                assert_eq!(
                    Library::load(self.conn.as_ref().unwrap()).unwrap(),
                    self.library
                );
            }
            3 => {
                self.editor.update(cx, |s, cx| {
                    s.set_value("Unsaved draft survives navigation", window, cx)
                });
            }
            4 => {
                assert_eq!(
                    self.editor.read(cx).value(),
                    "Unsaved draft survives navigation"
                );
                let path = crate::config::data_dir().unwrap().join("must-not-exist");
                let text = format!("touch '{}' # KIT_SEND_", path.display());
                self.editor
                    .update(cx, |s, cx| s.set_value(text, window, cx));
                self.save_editor(window, cx);
                let id = self.library.prompts.first().unwrap().id.clone();
                self.library.enqueue(&id);
                self.save(cx);
            }
            5 => {
                self.send_next(cx);
                assert!(self.library.queue.is_empty());
            }
            6 => {
                let text: String = (0..300).map(|i| format!("Line {i}: 中文 🦀\n")).collect();
                self.editor.update(cx, |s, cx| {
                    s.set_value(text, window, cx);
                    s.focus(window, cx);
                });
                window.defer(cx, |window, cx| {
                    window.dispatch_keystroke(gpui::Keystroke::parse("cmd-down").unwrap(), cx);
                });
            }
            7 => {
                assert!(
                    self.editor.read(cx).scroll_offset().y < px(-100.),
                    "long prompt did not scroll"
                );
                assert!(self.editor.read(cx).visible_row_range().unwrap().end >= 300);
            }
            _ => {}
        }
    }
}
