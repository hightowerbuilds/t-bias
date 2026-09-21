//! Window workspace. Pane entities own sessions independently of visible layout.
use crate::{
    config::{self, Config},
    db, gamepad,
    pane_tree::{Nav, Pane, PaneId, SplitDir},
    terminal_pane::TerminalPane,
    terminal_view::Theme,
    workspace::{TabId, Workspace},
};
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, relative, rgb, AnyElement, App, Bounds, Context, Entity, KeyDownEvent,
    MouseButton, Pixels, Subscription, Window,
};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type SessionKey = (TabId, PaneId);
struct Session {
    pane: Entity<TerminalPane>,
    _observer: Subscription,
    shell_record: Option<i64>,
}
pub struct WorkspaceView {
    workspace: Workspace,
    sessions: HashMap<SessionKey, Session>,
    conn: Option<rusqlite::Connection>,
    config: Config,
    error: Option<String>,
    save_generation: u64,
    pad_name: Option<String>,
    focused_once: bool,
    dragging_tab: Option<TabId>,
    prompt_panel: Entity<crate::prompt_panel::PromptPanel>,
    _prompt_events: Subscription,
    show_prompts: bool,
    split_drag: Option<(SessionKey, SplitDir, Bounds<Pixels>)>,
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
impl WorkspaceView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let mut error = None;
        let config = Config::load().unwrap_or_else(|e| {
            error = Some(format!("{e:#}"));
            Config::default()
        });
        let conn = db::default_db_path()
            .and_then(|p| db::open(&p))
            .map_err(|e| {
                error = Some(format!("{e:#}"));
            })
            .ok();
        let workspace = conn
            .as_ref()
            .and_then(|c| match db::load_workspace(c) {
                Ok(ws) => ws,
                Err(e) => {
                    error = Some(format!("Cannot restore workspace: {e:#}"));
                    None
                }
            })
            .filter(|w| !w.tabs.is_empty())
            .unwrap_or_default();
        if let Some(c) = &conn {
            let _ = c.execute(
                "UPDATE shells SET status='interrupted', exited_at=?1 WHERE status='running'",
                [now()],
            );
        }
        cx.on_app_quit(|this, cx| {
            this.save(cx);
            this.close_shell_records();
            this.sessions.clear();
            async {}
        })
        .detach();
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            if this
                .update(cx, |this, cx| {
                    if this.capture(cx) {
                        this.schedule_save(cx);
                    }
                })
                .is_err()
            {
                break;
            }
        })
        .detach();
        if let Some(mut events) = gamepad::spawn() {
            cx.spawn(async move |this, cx| {
                while let Some(event) = events.next().await {
                    if this
                        .update(cx, |this, cx| {
                            match &event {
                                gamepad::PadEvent::Connected(name) => {
                                    this.pad_name = Some(name.clone())
                                }
                                gamepad::PadEvent::Disconnected(_) => this.pad_name = None,
                                _ => {}
                            }
                            if let Some(pane) = this.active_pane() {
                                pane.update(cx, |p, cx| p.on_pad(event, cx));
                            }
                            cx.notify();
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        let prompt_panel = cx.new(crate::prompt_panel::PromptPanel::new);
        let prompt_events = cx.subscribe(&prompt_panel, |this, _, event, cx| {
            match event {
                crate::prompt_panel::PromptEvent::Send(text) => {
                    if let Some(p) = this.active_pane() {
                        p.update(cx, |p, cx| {
                            p.show_terminal(cx);
                            p.paste(text, cx);
                        });
                        this.focus_active(cx);
                    }
                }
                crate::prompt_panel::PromptEvent::Close => {
                    this.show_prompts = false;
                    this.focus_active(cx);
                }
            }
            cx.notify();
        });
        let mut this = Self {
            prompt_panel,
            _prompt_events: prompt_events,
            show_prompts: false,
            workspace,
            sessions: HashMap::new(),
            conn,
            config,
            error,
            save_generation: 0,
            pad_name: None,
            focused_once: false,
            dragging_tab: None,
            split_drag: None,
        };
        this.reconcile(cx);
        this
    }
    fn active_key(&self) -> Option<SessionKey> {
        self.workspace.active().map(|t| (t.id, t.active_pane))
    }
    fn active_pane(&self) -> Option<Entity<TerminalPane>> {
        self.sessions
            .get(&self.active_key()?)
            .map(|s| s.pane.clone())
    }
    fn reconcile(&mut self, cx: &mut Context<Self>) {
        let leaves: Vec<_> = self
            .workspace
            .tabs
            .iter()
            .flat_map(|tab| {
                tab.tree
                    .leaf_ids()
                    .into_iter()
                    .map(move |id| ((tab.id, id), tab.tree.get(id).cloned().unwrap()))
            })
            .collect();
        let keep: HashSet<_> = leaves.iter().map(|(key, _)| *key).collect();
        let remove: Vec<_> = self
            .sessions
            .keys()
            .filter(|key| !keep.contains(key))
            .copied()
            .collect();
        for key in remove {
            if let Some(s) = self.sessions.remove(&key) {
                if let (Some(c), Some(id)) = (&self.conn, s.shell_record) {
                    let _ = db::mark_shell_exited(
                        c,
                        id,
                        if s.pane.read(cx).exited {
                            "exited"
                        } else {
                            "closed"
                        },
                        now(),
                    );
                }
            }
        }
        for (key, model) in leaves {
            if self.sessions.contains_key(&key) {
                continue;
            }
            let (cwd, explorer) = match model {
                Pane::Terminal { cwd, flipped } => (cwd, flipped),
                Pane::Explorer { cwd } => (cwd, true),
                _ => continue,
            };
            let config = self.config.clone();
            let pane = cx
                .new(|cx| TerminalPane::new(cwd.as_deref().map(std::path::Path::new), config, cx));
            if explorer {
                pane.update(cx, |p, _| p.restore_explorer());
            }
            let shell_record = self.conn.as_ref().and_then(|c| {
                pane.read(cx).terminal.as_ref().and_then(|t| {
                    db::insert_shell(
                        c,
                        key.1,
                        t.pid().map(i64::from),
                        std::env::var("SHELL").ok().as_deref(),
                        cwd.as_deref(),
                        now(),
                    )
                    .map_err(|e| log::error!("shell record: {e}"))
                    .ok()
                })
            });
            let observer = cx.observe(&pane, move |this, pane, cx| {
                if pane.read(cx).exited {
                    if let Some(s) = this.sessions.get(&key) {
                        if let (Some(c), Some(id)) = (&this.conn, s.shell_record) {
                            let _ = db::mark_shell_exited(c, id, "exited", now());
                        }
                    }
                    this.workspace.handle_shell_exit(key.0, key.1);
                    this.reconcile(cx);
                    this.focus_active(cx);
                    this.schedule_save(cx);
                } else if this.capture(cx) {
                    this.schedule_save(cx);
                }
                cx.notify();
            });
            self.sessions.insert(
                key,
                Session {
                    pane,
                    _observer: observer,
                    shell_record,
                },
            );
        }
    }
    fn capture(&mut self, cx: &App) -> bool {
        let mut changed = false;
        for tab in &mut self.workspace.tabs {
            for id in tab.tree.leaf_ids() {
                let Some(s) = self.sessions.get(&(tab.id, id)) else {
                    continue;
                };
                let p = s.pane.read(cx);
                let cwd = p
                    .terminal
                    .as_ref()
                    .and_then(|t| t.cwd())
                    .map(|p| p.to_string_lossy().into_owned());
                let model = Pane::Terminal {
                    cwd,
                    flipped: p.is_explorer(),
                };
                if tab.tree.get(id) != Some(&model) {
                    tab.tree.replace_leaf(id, model);
                    changed = true;
                }
                if tab.active_pane == id && tab.title != p.title {
                    tab.title = p.title.clone();
                    changed = true;
                }
            }
        }
        changed
    }
    fn schedule_save(&mut self, cx: &mut Context<Self>) {
        self.save_generation += 1;
        let generation = self.save_generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(500))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.save_generation == generation {
                    this.save(cx);
                }
            });
        })
        .detach();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        self.capture(cx);
        if let Some(c) = &mut self.conn {
            if let Err(e) = db::save_workspace(c, &self.workspace, now()) {
                self.error = Some(format!("Cannot save workspace: {e:#}"));
                cx.notify();
            }
        }
    }
    pub fn prepare_close(&mut self, cx: &mut Context<Self>) {
        self.save(cx);
        self.close_shell_records();
    }
    fn close_shell_records(&self) {
        if let Some(c) = &self.conn {
            for s in self.sessions.values() {
                if let Some(id) = s.shell_record {
                    let _ = db::mark_shell_exited(c, id, "closed", now());
                }
            }
        }
    }
    fn focus_active(&self, cx: &mut Context<Self>) {
        if let Some(p) = self.active_pane() {
            p.update(cx, |p, cx| {
                p.focus_requested = true;
                cx.notify();
            });
        }
    }
    fn activate(&mut self, key: SessionKey, cx: &mut Context<Self>) {
        self.workspace.select_tab(key.0);
        self.workspace.activate_pane(key.1);
        self.focus_active(cx);
        self.schedule_save(cx);
        cx.notify();
    }
    fn action(&mut self, action: &str, cx: &mut Context<Self>) -> bool {
        self.capture(cx);
        match action {
            "prompts" => {
                self.show_prompts = !self.show_prompts;
                cx.notify();
                return true;
            }
            "send_next_prompt" => {
                self.prompt_panel.update(cx, |p, cx| p.send_next(cx));
                return true;
            }
            "settings" => {
                match config::path() {
                    Ok(path) => cx.open_with_system(&path),
                    Err(e) => {
                        self.error = Some(e.to_string());
                        cx.notify();
                    }
                }
                return true;
            }
            "new_tab" => {
                self.workspace.add_tab();
            }
            "close_pane" => self.workspace.close_active_pane(),
            "split_horizontal" => {
                self.workspace.split_active(SplitDir::Horizontal);
            }
            "split_vertical" => {
                self.workspace.split_active(SplitDir::Vertical);
            }
            "zoom" => self.workspace.toggle_zoom(),
            "previous_tab" => self.workspace.cycle_tab(-1),
            "next_tab" => self.workspace.cycle_tab(1),
            "pane_left" => self.workspace.navigate(Nav::Left),
            "pane_right" => self.workspace.navigate(Nav::Right),
            "pane_up" => self.workspace.navigate(Nav::Up),
            "pane_down" => self.workspace.navigate(Nav::Down),
            _ => {
                if let Some(p) = self.active_pane() {
                    return p.update(cx, |p, cx| p.perform(action, cx));
                }
                return false;
            }
        }
        self.reconcile(cx);
        self.focus_active(cx);
        self.schedule_save(cx);
        cx.notify();
        true
    }
    fn key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        if let Some(action) = self.config.action(key).map(str::to_string) {
            if self.action(&action, cx) {
                cx.stop_propagation();
            }
            return;
        }
        if key.modifiers.platform
            && !key.modifiers.shift
            && !key.modifiers.alt
            && !key.modifiers.control
        {
            if let Ok(index) = key.key.parse::<usize>() {
                if (1..=9).contains(&index) {
                    self.workspace.select_tab_index(index - 1);
                    self.focus_active(cx);
                    self.schedule_save(cx);
                    cx.stop_propagation();
                    cx.notify();
                }
            }
        }
    }
    fn node(&self, key: SessionKey, cx: &mut Context<Self>) -> AnyElement {
        let Some(tab) = self.workspace.tab(key.0) else {
            return div().into_any_element();
        };
        match tab.tree.get(key.1).cloned() {
            Some(Pane::Split { dir, ratio, a, b }) => {
                let horizontal = dir == SplitDir::Horizontal;
                let bounds = Rc::new(Cell::new(None::<Bounds<Pixels>>));
                let measure = bounds.clone();
                let drag_bounds = bounds.clone();
                div()
                    .id(gpui::SharedString::from(format!(
                        "split-{}-{}",
                        key.0, key.1
                    )))
                    .relative()
                    .flex()
                    .size_full()
                    .when(!horizontal, |d| d.flex_col())
                    .child(
                        div().absolute().size_full().child(
                            gpui::canvas(
                                move |b, _, _| {
                                    measure.set(Some(b));
                                },
                                |_, _, _, _| {},
                            )
                            .size_full(),
                        ),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .min_h_0()
                            .flex_shrink_0()
                            .when(horizontal, |d| d.w(relative(ratio)).h_full())
                            .when(!horizontal, |d| d.h(relative(ratio)).w_full())
                            .child(self.node((key.0, a), cx)),
                    )
                    .child(
                        div()
                            .id(gpui::SharedString::from(format!(
                                "divider-{}-{}",
                                key.0, key.1
                            )))
                            .flex_shrink_0()
                            .bg(rgb(0x30363d))
                            .when(horizontal, |d| d.w(px(5.)).h_full().cursor_col_resize())
                            .when(!horizontal, |d| d.h(px(5.)).w_full().cursor_row_resize())
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, _, cx| {
                                    this.split_drag = drag_bounds.get().map(|b| (key, dir, b));
                                    cx.stop_propagation();
                                }),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .min_h_0()
                            .h_full()
                            .child(self.node((key.0, b), cx)),
                    )
                    .into_any_element()
            }
            Some(_) => {
                let active = self.active_key() == Some(key);
                let pane = self.sessions.get(&key).map(|s| s.pane.clone());
                div()
                    .id(gpui::SharedString::from(format!(
                        "pane-{}-{}",
                        key.0, key.1
                    )))
                    .size_full()
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .border_1()
                    .border_color(if active { rgb(0x58a6ff) } else { rgb(0x30363d) })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| this.activate(key, cx)),
                    )
                    .children(pane)
                    .into_any_element()
            }
            None => div().into_any_element(),
        }
    }
}
impl Render for WorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        window.set_window_title(&format!(
            "{} — t-bias",
            self.workspace
                .active()
                .map(|t| t.title.as_str())
                .unwrap_or("Terminal")
        ));
        if !self.focused_once {
            self.focused_once = true;
            self.focus_active(cx);
        }
        let mut tabs = div()
            .id("tab-strip")
            .overflow_x_scroll()
            .flex()
            .items_center()
            .gap_1()
            .px_2()
            .py_1()
            .bg(Theme::from_config(&self.config).chrome())
            .text_color(Theme::from_config(&self.config).fg);
        for tab in &self.workspace.tabs {
            let id = tab.id;
            let active = id == self.workspace.active_tab;
            tabs = tabs.child(
                div()
                    .id(("tab", id as usize))
                    .flex()
                    .items_center()
                    .px_2()
                    .py_1()
                    .gap_2()
                    .rounded_md()
                    .bg(if active {
                        rgb(0x30363d)
                    } else {
                        Theme::from_config(&self.config).chrome()
                    })
                    .child(tab.title.chars().take(28).collect::<String>())
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.dragging_tab = Some(id);
                            this.workspace.select_tab(id);
                            this.focus_active(cx);
                            cx.notify();
                        }),
                    )
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            if let Some(from) = this.dragging_tab.take() {
                                this.workspace.reorder_tab(from, id);
                            }
                            this.schedule_save(cx);
                            cx.notify();
                        }),
                    )
                    .child(
                        div()
                            .id(("close-tab", id as usize))
                            .px_1()
                            .child("×")
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.workspace.close_tab(id);
                                this.reconcile(cx);
                                this.focus_active(cx);
                                this.schedule_save(cx);
                                cx.stop_propagation();
                                cx.notify();
                            })),
                    ),
            );
        }
        for (id, label, action) in [
            ("add-tab", "+", "new_tab"),
            ("split-h", "◫", "split_horizontal"),
            ("split-v", "⊟", "split_vertical"),
            ("zoom", "↗", "zoom"),
            ("prompts", "Prompts", "prompts"),
            ("settings", "Settings", "settings"),
        ] {
            tabs = tabs.child(
                div()
                    .id(id)
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .hover(|d| d.bg(rgb(0x30363d)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.action(action, cx);
                    })),
            );
        }
        let body = if let Some(tab) = self.workspace.active() {
            self.node(
                (
                    tab.id,
                    if tab.zoomed {
                        tab.active_pane
                    } else {
                        tab.tree.root()
                    },
                ),
                cx,
            )
        } else {
            div().into_any_element()
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .font_family(self.config.font_family.clone())
            .text_size(px(13.))
            .bg(Theme::from_config(&self.config).bg)
            .on_key_down(cx.listener(Self::key))
            .on_action(cx.listener(|this, _: &crate::menus::NewTab, _, cx| {
                this.action("new_tab", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::ClosePane, _, cx| {
                this.action("close_pane", cx);
            }))
            .on_action(
                cx.listener(|this, _: &crate::menus::SplitHorizontal, _, cx| {
                    this.action("split_horizontal", cx);
                }),
            )
            .on_action(cx.listener(|this, _: &crate::menus::SplitVertical, _, cx| {
                this.action("split_vertical", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Zoom, _, cx| {
                this.action("zoom", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::NextTab, _, cx| {
                this.action("next_tab", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::PreviousTab, _, cx| {
                this.action("previous_tab", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Copy, _, cx| {
                this.action("copy", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Paste, _, cx| {
                this.action("paste", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Flip, _, cx| {
                this.action("flip", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Prompts, _, cx| {
                this.action("prompts", cx);
            }))
            .on_action(
                cx.listener(|this, _: &crate::menus::SendNextPrompt, _, cx| {
                    this.action("send_next_prompt", cx);
                }),
            )
            .on_action(cx.listener(|this, _: &crate::menus::Settings, _, cx| {
                this.action("settings", cx);
            }))
            .on_action(cx.listener(|_, _: &crate::menus::About, window, cx| {
                let _ = window.prompt(
                    gpui::PromptLevel::Info,
                    "t-bias",
                    Some("Native terminal • GPUI + Alacritty\nVersion 0.1.0"),
                    &["OK"],
                    cx,
                );
            }))
            .on_mouse_move(cx.listener(|this, event: &gpui::MouseMoveEvent, _, cx| {
                if !event.dragging() {
                    this.split_drag = None;
                    return;
                }
                if let Some((key, dir, b)) = this.split_drag {
                    let ratio = if dir == SplitDir::Horizontal {
                        f32::from(event.position.x - b.origin.x) / f32::from(b.size.width)
                    } else {
                        f32::from(event.position.y - b.origin.y) / f32::from(b.size.height)
                    };
                    if let Some(tab) = this.workspace.tabs.iter_mut().find(|t| t.id == key.0) {
                        tab.tree.set_ratio(key.1, ratio);
                    }
                    this.schedule_save(cx);
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.split_drag = None),
            )
            .child(tabs)
            .when_some(self.error.clone(), |d, error| {
                d.child(div().px_2().py_1().text_color(rgb(0xff7b72)).child(error))
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(div().flex_1().min_w_0().h_full().child(body))
                    .when(self.show_prompts, |d| d.child(self.prompt_panel.clone())),
            )
    }
}

impl WorkspaceView {
    /// Exercises real shells and rendered entities; the launcher supplies isolated data.
    pub fn start_smoke(&mut self, cx: &mut Context<Self>) {
        assert!(
            std::env::var_os("TBIAS_DATA_DIR").is_some(),
            "smoke test requires isolated TBIAS_DATA_DIR"
        );
        cx.spawn(async move |this,cx| {
            let mut first_pid=None;
            for step in 0..20 {
                cx.background_executor().timer(Duration::from_millis(750)).await;
                this.update(cx,|this,cx| {
                    match step {
                        0=>{
                            first_pid=this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().pid();
                            this.active_pane().unwrap().update(cx,|p,cx|{
                                p.paste("printf '%s%s\\n' SMOKE_ READY",cx);
                                p.smoke_enter(cx);
                            });
                        }
                        1=>{
                            let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                            let text:String=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect();
                            assert!(text.contains("SMOKE_READY"),"shell did not execute Enter: {text}");
                            pane.update(cx,|p,cx|p.smoke_copy("SMOKE_READY",cx));
                            this.action("split_horizontal",cx);
                        }
                        2=>{this.action("split_vertical",cx);assert_eq!(this.sessions.len(),3);}
                        3=>{this.action("zoom",cx);assert_eq!(this.sessions.len(),3);}
                        4=>{this.action("zoom",cx);this.action("new_tab",cx);assert_eq!(this.sessions.len(),4);}
                        5=>{this.action("previous_tab",cx);assert!(this.sessions.values().any(|s|s.pane.read(cx).terminal.as_ref().and_then(|t|t.pid())==first_pid));}
                        6=>{
                            this.save(cx);
                            let restored=db::load_workspace(this.conn.as_ref().unwrap()).unwrap().unwrap();
                            assert_eq!(restored,this.workspace);
                            this.action("prompts",cx);
                        }
                        7=>{this.action("flip",cx);}
                        8=>{this.action("flip",cx);}
                        9=>{this.action("close_pane",cx);assert_eq!(this.sessions.len(),3);}
                        10=>{this.show_prompts=false;this.action("zoom",cx);this.active_pane().unwrap().update(cx,|p,cx|{p.paste("vim -Nu NONE -n",cx);p.smoke_enter(cx);});}
                        11=>{let pane=this.active_pane().unwrap();assert!(pane.read(cx).terminal.as_ref().unwrap().handle().mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN));pane.read(cx).terminal.as_ref().unwrap().handle().input(b"iNATIVE_VIM_OK\x1b:q!\r".to_vec());}
                        12=>{assert!(!this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().handle().mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN));this.active_pane().unwrap().update(cx,|p,cx|{p.paste("printf 'LESS_SMOKE\\n' | less -+F",cx);p.smoke_enter(cx);});}
                        13=>{let pane=this.active_pane().unwrap();assert!(pane.read(cx).terminal.as_ref().unwrap().handle().mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN));pane.read(cx).terminal.as_ref().unwrap().handle().input(b"q".to_vec());}
                        14=>{this.active_pane().unwrap().update(cx,|p,cx|{p.paste(&format!("tmux -L tbias-native-smoke-{} -f /dev/null new-session -s smoke",std::process::id()),cx);p.smoke_enter(cx);});}
                        15=>{let pane=this.active_pane().unwrap();assert!(pane.read(cx).terminal.as_ref().unwrap().handle().mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN));pane.read(cx).terminal.as_ref().unwrap().handle().input(b"exit\r".to_vec());}
                        16=>{assert!(!this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().handle().mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN));this.active_pane().unwrap().update(cx,|p,cx|p.smoke_markdown(cx));}
                        17=>{this.active_pane().unwrap().update(cx,|p,cx|p.show_terminal(cx));this.action("zoom",cx);}
                        18=>{this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().handle().input(b"exit\r".to_vec());}
                        19=>{assert_eq!(this.sessions.len(),2,"shell exit did not collapse its pane");this.save(cx);log::info!("NATIVE_SMOKE_OK: shell input, selection/copy, split, zoom, tabs, session survival, SQLite restore, prompts, flip, close, vim, less, tmux, markdown, shell exit");}
                        _=>{}
                    }
                    cx.notify();
                }).expect("smoke window disappeared");
            }
            if std::env::var_os("TBIAS_SMOKE_KEEP_OPEN").is_none(){let _=cx.update(|cx|cx.quit());}
        }).detach();
    }
}
