use crate::{prompts::Library, text_field::TextField};
use gpui::{div, prelude::*, px, rgb, Context, Entity, EventEmitter, Subscription, Window};
pub enum PromptEvent {
    Send(String),
    Close,
}
pub struct PromptPanel {
    library: Library,
    conn: Option<rusqlite::Connection>,
    search: Entity<TextField>,
    editor: Entity<TextField>,
    tags: Entity<TextField>,
    editing: Option<String>,
    error: Option<String>,
    _search: Subscription,
}
impl EventEmitter<PromptEvent> for PromptPanel {}
impl PromptPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
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
        let search = cx.new(|cx| TextField::new("Search prompts or tags", false, cx));
        let editor = cx.new(|cx| TextField::new("Write a prompt…", true, cx));
        let tags = cx.new(|cx| TextField::new("Tags, separated by commas", false, cx));
        let observer = cx.observe(&search, |_, _, cx| cx.notify());
        Self {
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
    fn save_editor(&mut self, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).text.clone();
        let tags: Vec<_> = self
            .tags
            .read(cx)
            .text
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
        self.editor
            .update(cx, |f, cx| f.set_text(String::new(), cx));
        self.tags.update(cx, |f, cx| f.set_text(String::new(), cx));
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
fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<gpui::SharedString>,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px_2()
        .py_1()
        .rounded_md()
        .bg(rgb(0x21262d))
        .hover(|d| d.bg(rgb(0x30363d)))
        .child(label.into())
}
impl Render for PromptPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.search.read(cx).text.to_lowercase();
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
                    .border_color(rgb(0x30363d))
                    .rounded_md()
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(p.text.chars().take(400).collect::<String>())
                    .child(div().text_color(rgb(0x58a6ff)).child(tags))
                    .child(
                        div()
                            .flex()
                            .gap_1()
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
                                move |this, _, _, cx| {
                                    if let Some(p) =
                                        this.library.prompts.iter().find(|p| p.id == edit).cloned()
                                    {
                                        this.editing = Some(edit.clone());
                                        this.editor.update(cx, |f, cx| f.set_text(p.text, cx));
                                        this.tags
                                            .update(cx, |f, cx| f.set_text(p.tags.join(", "), cx));
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
            .bg(rgb(0x161b22))
            .text_color(rgb(0xe6edf3))
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
            .child(self.search.clone())
            .child(self.editor.clone())
            .child(self.tags.clone())
            .child(
                button(
                    "save",
                    if self.editing.is_some() {
                        "Save changes"
                    } else {
                        "Save prompt"
                    },
                )
                .on_click(cx.listener(|this, _, _, cx| this.save_editor(cx))),
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
            .child(queue)
            .child(list)
    }
}
