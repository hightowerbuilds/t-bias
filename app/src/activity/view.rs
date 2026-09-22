mod table;
use super::{
    collector::{Request, Sampler, Snapshot},
    model::{self, Identity, Scope, ShellRoot, Sort},
};
use crate::{config::Config, terminal_view::Theme};
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, rgb, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    Subscription, Window,
};
use gpui_kit::component::{
    input::{Input, InputEvent, InputState},
    Selectable,
};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Processes,
    Learn,
    Computer,
}
pub enum MonitorEvent {
    Close,
    Reveal(ShellRoot),
    SurfaceChanged,
}
pub struct ActivityMonitor {
    sampler: Option<Sampler>,
    snapshot: Option<Arc<Snapshot>>,
    request: Request,
    generation: u64,
    search: Entity<InputState>,
    _search: Subscription,
    focus: FocusHandle,
    focus_requested: bool,
    select_first: bool,
    activation: Option<Subscription>,
    table: Option<Entity<gpui_kit::component::table::TableState<table::Processes>>>,
    table_events: Option<Subscription>,
    theme: Theme,
    error: Option<String>,
    show_columns: bool,
    surface: Surface,
    world: Entity<super::world::ComputerWorld>,
    _world: Subscription,
    lessons: Vec<Vec<crate::markdown::Block>>,
    lesson: usize,
    lesson_scroll: gpui::ScrollHandle,
}
impl EventEmitter<MonitorEvent> for ActivityMonitor {}
impl ActivityMonitor {
    pub fn new(config: &Config, search: Entity<InputState>, cx: &mut Context<Self>) -> Self {
        let observer = cx.subscribe(&search, |this, field, event, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.focus_requested = true;
                this.request.selected = this
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.rows.first().map(|i| s.processes[*i].id));
                this.select_first = this.snapshot.is_none();
                this.submit();
                cx.notify();
                return;
            }
            let query = field.read(cx).value().to_string();
            if this.request.query != query {
                this.request.query = query;
                this.request.selected = None;
                this.submit();
                cx.notify();
            }
        });
        let world = cx.new(super::world::ComputerWorld::new);
        let world_events = cx.subscribe(&world, |this, _, event, cx| match event {
            super::world::WorldEvent::Back => this.show_surface(Surface::Processes, cx),
            super::world::WorldEvent::Learn(index) => {
                this.lesson = *index;
                this.show_surface(Surface::Learn, cx);
            }
        });
        let lessons = [
            include_str!("../../../docs/learning/01-processes.md"),
            include_str!("../../../docs/learning/02-cpu-and-time.md"),
            include_str!("../../../docs/learning/03-memory.md"),
        ]
        .into_iter()
        .map(|text| {
            crate::markdown::parse(
                &text
                    .lines()
                    .map(|line| {
                        if line.starts_with("**Lesson ID:**") {
                            line.split_once('·')
                                .map(|(_, rest)| rest.trim())
                                .unwrap_or("")
                        } else {
                            line
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })
        .collect();
        let path = crate::db::default_db_path().ok();
        let (prefs, storage, error) = match path {
            Some(path) => match super::preferences::load(&path) {
                Ok(prefs) => (prefs, Some(path), None),
                Err(e) => (
                    super::preferences::Preferences::default(),
                    None,
                    Some(format!(
                        "Monitor preferences unavailable (file preserved): {e}"
                    )),
                ),
            },
            None => (
                super::preferences::Preferences::default(),
                None,
                Some("Monitor preferences cannot be saved".into()),
            ),
        };
        let mut this = Self {
            sampler: None,
            snapshot: None,
            request: Request {
                interval: config.activity_monitor.refresh_seconds,
                scope: prefs.scope,
                sort: prefs.sort,
                descending: prefs.descending,
                tree: prefs.tree,
                columns: prefs.columns,
                ..Default::default()
            },
            generation: 0,
            search,
            _search: observer,
            focus: cx.focus_handle(),
            focus_requested: false,
            select_first: false,
            activation: None,
            table: None,
            table_events: None,
            theme: Theme::from_config(config),
            error,
            show_columns: false,
            surface: Surface::Processes,
            world,
            _world: world_events,
            lessons,
            lesson: 0,
            lesson_scroll: gpui::ScrollHandle::new(),
        };
        match Sampler::with_storage(storage) {
            Ok((sampler, mut events)) => {
                this.sampler = Some(sampler);
                cx.spawn(async move |this, cx| {
                    while events.next().await.is_some() {
                        if this
                            .update(cx, |this, cx| {
                                if let Some(snapshot) =
                                    this.sampler.as_ref().and_then(Sampler::latest)
                                {
                                    if snapshot.generation == this.generation {
                                        this.request.expanded.retain(|id| {
                                            snapshot.processes.iter().any(|p| p.id == *id)
                                        });
                                        if this.select_first {
                                            this.select_first = false;
                                            this.request.selected = snapshot
                                                .rows
                                                .first()
                                                .map(|i| snapshot.processes[*i].id);
                                            this.submit();
                                        }
                                        this.snapshot = Some(snapshot);
                                        cx.notify();
                                    }
                                }
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
            }
            Err(e) => this.error = Some(format!("Cannot start Activity Monitor: {e}")),
        }
        this
    }
    fn submit(&mut self) {
        if let Some(s) = &self.sampler {
            self.generation = s.request(self.request.clone());
        }
    }
    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        self.request.visible = visible;
        self.world.update(cx, |w, cx| {
            w.visible(visible && self.surface == Surface::Computer, cx)
        });
        self.focus_requested = visible;
        self.submit();
        cx.notify();
    }
    pub fn set_roots(&mut self, roots: Vec<ShellRoot>, active: Option<(u64, u64)>) {
        if self.request.roots != roots || self.request.active_pane != active {
            self.request.roots = roots;
            self.request.active_pane = active;
            self.submit();
        }
    }
    pub fn clipboard(&mut self, action: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.focus_handle(cx).is_focused(window) {
            if action == "copy" {
                window.dispatch_action(Box::new(gpui_kit::component::input::Copy), cx);
            } else {
                window.dispatch_action(Box::new(gpui_kit::component::input::Paste), cx);
            }
        } else if action == "copy" {
            if let Some(p) = self.snapshot.as_ref().and_then(|s| {
                s.processes
                    .iter()
                    .find(|p| Some(p.id) == self.request.selected)
            }) {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(format!(
                    "{}\t{}\t{}\t{}",
                    p.name,
                    p.id.pid,
                    p.cpu
                        .map(|c| format!("{c:.1}%"))
                        .unwrap_or_else(|| "—".into()),
                    model::bytes(p.rss)
                )));
            }
        }
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &event.keystroke;
        if self.surface != Surface::Processes {
            if k.key == "escape" {
                self.show_surface(Surface::Processes, cx);
                cx.stop_propagation();
            } else if self.surface == Surface::Learn
                && ["up", "down", "pageup", "pagedown"].contains(&k.key.as_str())
            {
                let amount = if k.key.contains("page") { 280. } else { 40. };
                self.scroll_lesson(
                    if k.key.ends_with("up") {
                        amount
                    } else {
                        -amount
                    },
                    cx,
                );
                cx.stop_propagation();
            }
            return;
        }
        if k.modifiers.platform && k.key == "f" {
            let f = self.search.focus_handle(cx).clone();
            window.focus(&f, cx);
            cx.stop_propagation();
            return;
        }
        if k.modifiers.platform && ["c", "v"].contains(&k.key.as_str()) {
            self.clipboard(if k.key == "c" { "copy" } else { "paste" }, window, cx);
            cx.stop_propagation();
            return;
        }
        if k.key == "escape" {
            if !self.request.query.is_empty() {
                self.search.update(cx, |s, cx| s.set_value("", window, cx));
            } else if self.request.selected.take().is_some() {
                self.submit();
            } else {
                cx.emit(MonitorEvent::Close);
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        // Arrow keys in the search field remain native text-editing keys.
        if self.search.focus_handle(cx).is_focused(window) {
            if k.key == "enter" {
                window.focus(&self.focus, cx);
            } else {
                return;
            }
        }
        if ["up", "down", "enter"].contains(&k.key.as_str()) {
            if let Some(s) = &self.snapshot {
                if s.generation != self.generation {
                    self.select_first = true;
                    cx.stop_propagation();
                    return;
                }
                if !s.rows.is_empty() {
                    let old = s
                        .rows
                        .iter()
                        .position(|i| Some(s.processes[*i].id) == self.request.selected);
                    let index = match (old, k.key.as_str()) {
                        (Some(i), "up") => i.saturating_sub(1),
                        (Some(i), "down") => (i + 1).min(s.rows.len() - 1),
                        (Some(i), _) => i,
                        _ => 0,
                    };
                    self.request.selected = Some(s.processes[s.rows[index]].id);
                    if let Some(table) = &self.table {
                        table.update(cx, |t, cx| t.scroll_to_row(index, cx));
                    }
                    self.submit();
                }
            }
            cx.stop_propagation();
            cx.notify();
        }
    }
    pub fn surface(&self) -> Surface {
        self.surface
    }
    pub fn show_surface(&mut self, surface: Surface, cx: &mut Context<Self>) {
        self.surface = surface;
        self.focus_requested = true;
        self.world.update(cx, |w, cx| {
            w.visible(surface == Surface::Computer && self.request.visible, cx)
        });
        cx.emit(MonitorEvent::SurfaceChanged);
        cx.notify();
    }
    fn scroll_lesson(&self, amount: f32, cx: &mut Context<Self>) {
        let mut offset = self.lesson_scroll.offset();
        offset.y += px(amount);
        self.lesson_scroll.set_offset(offset);
        cx.notify();
    }
    pub fn on_pad(&mut self, event: crate::gamepad::PadEvent, cx: &mut Context<Self>) {
        if self.surface == Surface::Learn && self.request.visible && self.request.active {
            use crate::gamepad::{PadEvent, PsButton, Stick};
            match &event {
                PadEvent::Pressed(PsButton::Circle) => self.show_surface(Surface::Processes, cx),
                PadEvent::Pressed(PsButton::Left) => {
                    self.lesson = (self.lesson + 2) % 3;
                    self.lesson_scroll.set_offset(gpui::point(px(0.), px(0.)));
                    cx.notify();
                }
                PadEvent::Pressed(PsButton::Right) => {
                    self.lesson = (self.lesson + 1) % 3;
                    self.lesson_scroll.set_offset(gpui::point(px(0.), px(0.)));
                    cx.notify();
                }
                PadEvent::Stick {
                    stick: Stick::Left,
                    y,
                    ..
                } => self.scroll_lesson(*y * 4., cx),
                _ => {}
            }
        }
        self.world.update(cx, |w, cx| w.on_pad(event, cx));
    }
    pub fn smoke_learning(&mut self, cx: &mut Context<Self>) {
        assert!(self.lessons.iter().all(|l| !l.is_empty()));
        self.show_surface(Surface::Learn, cx);
    }
    pub fn smoke_input_active(&self) -> bool {
        self.request.active && self.request.visible
    }
    pub fn smoke_computer(&mut self, cx: &mut Context<Self>) {
        self.show_surface(Surface::Computer, cx);
    }
    pub fn smoke_camera(&self, cx: &gpui::App) -> ([f32; 3], bool) {
        self.world.read(cx).smoke_camera()
    }
    pub fn smoke_table(&mut self, cx: &mut Context<Self>) {
        self.show_surface(Surface::Processes, cx);
        self.request.tree = true;
        self.request.sort = Sort::Memory;
        self.submit();
        cx.notify();
    }
    pub fn smoke_ready(&self) -> bool {
        self.snapshot.as_ref().is_some_and(|s| {
            s.sequence >= 2
                && s.error.is_none()
                && s.processes
                    .iter()
                    .any(|p| p.name == "sleep" && p.shell.is_some())
        })
    }
    pub fn smoke_filter(&mut self, cx: &mut Context<Self>) {
        self.request.scope = Scope::Workspace;

        self.submit();
        cx.notify();
    }
    pub fn smoke_filtered(&self) -> bool {
        self.snapshot.as_ref().is_some_and(|s| {
            s.generation == self.generation
                && !s.rows.is_empty()
                && s.rows.iter().all(|i| s.processes[*i].shell.is_some())
        })
    }
}
fn control(
    id: impl Into<gpui::ElementId>,
    label: impl Into<gpui::SharedString>,
    _theme: Theme,
    chosen: bool,
) -> gpui_kit::component::button::Button {
    crate::ui::button(id, label).selected(chosen)
}
fn graph(values: Vec<Option<f64>>, color: gpui::Rgba) -> impl IntoElement {
    gpui::canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            let width = f32::from(bounds.size.width) / 60.;
            for (i, v) in values.iter().enumerate() {
                if let Some(v) = v {
                    let h =
                        (v.clamp(0., 100.) as f32 / 100. * f32::from(bounds.size.height)).max(1.);
                    window.paint_quad(gpui::fill(
                        gpui::Bounds::new(
                            gpui::point(
                                bounds.origin.x + px(i as f32 * width),
                                bounds.bottom() - px(h),
                            ),
                            gpui::size(px((width - 1.).max(1.)), px(h)),
                        ),
                        color,
                    ));
                }
            }
        },
    )
    .w_full()
    .h(px(36.))
}
impl Render for ActivityMonitor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.activation.is_none() {
            self.request.active = window.is_window_active();
            self.submit();
            self.activation = Some(cx.observe_window_activation(window, |this, window, cx| {
                this.request.active = window.is_window_active();
                this.submit();
                cx.notify();
            }));
        }
        if self.focus_requested {
            window.focus(&self.focus, cx);
            self.focus_requested = false;
        }
        let theme = self.theme;
        if self.surface == Surface::Computer {
            let system = self
                .snapshot
                .as_ref()
                .map(|s| s.system.clone())
                .unwrap_or_default();
            let age = self
                .snapshot
                .as_ref()
                .map(|s| s.sampled.elapsed().as_secs());
            let live = self.request.running();
            self.world
                .update(cx, |w, cx| w.sample(system, age, live, cx));
            return div()
                .size_full()
                .child(self.world.clone())
                .into_any_element();
        }
        if self.surface == Surface::Learn {
            let mut tabs = div().flex().flex_wrap().gap_2();
            for (i, label) in [
                (0, "1 · Processes"),
                (1, "2 · CPU & time"),
                (2, "3 · Memory"),
            ] {
                tabs = tabs.child(
                    control(("lesson", i), label, theme, self.lesson == i).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.lesson = i;
                            this.lesson_scroll.set_offset(gpui::point(px(0.), px(0.)));
                            cx.notify();
                        },
                    )),
                );
            }
            return div().id("activity-learn").min_w_0().track_focus(&self.focus).on_key_down(cx.listener(Self::key)).size_full().flex().flex_col().min_h_0().bg(theme.bg).text_color(theme.fg)
                .child(div().p_3().flex().flex_wrap().gap_2().child("Inside Your Computer · Introductory CS")
                    .child(control("lesson-back","Back to monitor",theme,false).on_click(cx.listener(|this,_,_,cx|this.show_surface(Surface::Processes,cx))))
                    .child(control("lesson-computer","Explore computer",theme,false).on_click(cx.listener(|this,_,_,cx|this.show_surface(Surface::Computer,cx)))))
                .child(div().px_3().pb_2().child(tabs))
                .child(div().id(("lesson-reader",self.lesson)).w_full().min_w_0().overflow_y_scroll().track_scroll(&self.lesson_scroll).flex_1().min_h_0().p_4().child(crate::markdown::markdown_content(&self.lessons[self.lesson],15.,if theme.bg.r>0.5 {crate::markdown::Skin::Newspaper}else{crate::markdown::Skin::Default})))
                .child(div().px_3().py_2().text_size(px(12.)).child("Read-only exercises · Arrows / Page Up/Down scroll · Controller: left stick scrolls, d-pad switches lessons, ○ returns"))
                .into_any_element();
        }
        let compact =
            window.viewport_size().height < px(600.) || window.viewport_size().width < px(850.);
        let snapshot = self.snapshot.clone();
        let system = snapshot
            .as_ref()
            .map(|s| s.system.clone())
            .unwrap_or_default();
        let history = snapshot
            .as_ref()
            .map(|s| s.history.clone())
            .unwrap_or_default();
        let status = if self.request.paused {
            "Paused"
        } else if !self.request.active {
            "Paused while inactive"
        } else if snapshot.as_ref().is_some_and(|s| s.sequence > 0) {
            "Live"
        } else {
            "Reading processes…"
        };
        let mut scopes = div().flex().items_center().gap_2();
        for (id, label, scope) in [
            ("all", "All Processes", Scope::All),
            ("mine", "My Processes", Scope::Mine),
            ("workspace", "This Workspace", Scope::Workspace),
            ("pane", "Active Pane", Scope::Pane),
        ] {
            scopes = scopes.child(
                control(id, label, theme, self.request.scope == scope).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.request.scope = scope;
                        this.submit();
                        cx.notify();
                    },
                )),
            );
        }
        let table = self.process_table(window, cx);
        let mut detail = div()
            .h(px(100.))
            .flex_shrink_0()
            .overflow_hidden()
            .px_4()
            .py_2()
            .border_t_1()
            .border_color(theme.raised());
        if let Some(id) = self.request.selected {
            if let Some(p) = snapshot
                .as_ref()
                .and_then(|s| s.processes.iter().find(|p| p.id == id))
            {
                detail = detail
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .child(format!(
                                        "{} · PID {} · parent {} · {}",
                                        p.name, id.pid, p.parent, p.owner
                                    )),
                            )
                            .when_some(p.shell.clone(), |d, root| {
                                d.child(
                                    control("reveal", "Show in Terminal", theme, false).on_click(
                                        cx.listener(move |_, _, _, cx| {
                                            cx.emit(MonitorEvent::Reveal(root.clone()))
                                        }),
                                    ),
                                )
                            }),
                    )
                    .child(
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_color(theme.muted())
                            .child(format!(
                                "CPU {} · RSS {} · process age {}",
                                p.cpu
                                    .map(|n| format!("{n:.1}%"))
                                    .unwrap_or_else(|| "warming up / unavailable".into()),
                                model::bytes(p.rss),
                                process_age(id.seconds)
                            )),
                    )
                    .child(
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_color(theme.muted())
                            .child(
                                snapshot
                                    .as_ref()
                                    .filter(|s| s.generation == self.generation)
                                    .and_then(|s| s.selected_path.clone())
                                    .unwrap_or_else(|| {
                                        "Executable path unavailable or loading".into()
                                    }),
                            ),
                    );
                if let Some(s) = &snapshot {
                    if let Some(i) = s.processes.iter().position(|p| p.id == id) {
                        let t = s.totals[i];
                        detail=detail.child(div().text_color(theme.muted()).child(format!("Observed subtree: {} processes · CPU {:.1}%{} · RSS {}{} (shared pages may overlap)",t.count,t.cpu,if t.missing_cpu>0 {" + unknown"}else{""},model::bytes(Some(t.rss)),if t.missing_rss>0 {" + unknown"}else{""})));
                    }
                }
            } else {
                detail = detail.child("Selected process exited or is no longer accessible.");
            }
        } else {
            detail=detail.child("Select a process to inspect it. ⌘F searches; arrows select; ⌘C copies a row.").child(div().text_color(theme.muted()).child("CPU: 100% = one logical core. RSS includes shared pages. Local processes only."));
        }
        let error = self
            .error
            .clone()
            .or_else(|| snapshot.as_ref().and_then(|s| s.error.clone()));
        let overview = if compact {
            div()
                .px_4()
                .pb_2()
                .text_color(theme.muted())
                .child(format!(
                    "CPU {} · RAM {} · wired {}",
                    system
                        .cpu
                        .map(|n| format!("{n:.1}%"))
                        .unwrap_or_else(|| "—".into()),
                    model::bytes(system.memory_total),
                    model::bytes(system.memory_wired)
                ))
                .into_any_element()
        } else {
            div()
                .flex()
                .gap_3()
                .px_4()
                .pb_3()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .p_3()
                        .rounded_md()
                        .bg(theme.chrome())
                        .child(format!(
                            "CPU · {}",
                            system
                                .cpu
                                .map(|n| format!("{n:.1}% of machine"))
                                .unwrap_or_else(|| "warming up / unavailable".into())
                        ))
                        .child(graph(history.iter().map(|h| h.0).collect(), rgb(0x58a6ff))),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .p_3()
                        .rounded_md()
                        .bg(theme.chrome())
                        .child(format!(
                            "Memory · {} physical",
                            model::bytes(system.memory_total)
                        ))
                        .child(div().text_color(theme.muted()).child(format!(
                            "Wired {} · active {} · compressed {}",
                            model::bytes(system.memory_wired),
                            model::bytes(system.memory_active),
                            model::bytes(system.memory_compressed)
                        )))
                        .child(graph(history.iter().map(|h| h.1).collect(), rgb(0x3fb950)))
                        .child(
                            div()
                                .text_color(theme.muted())
                                .child("Wired memory history (% of physical RAM)"),
                        ),
                )
                .into_any_element()
        };
        div()
            .id("activity-monitor")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .bg(theme.bg)
            .text_color(theme.fg)
            .text_size(px(12.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_4()
                    .py_3()
                    .child(
                        div()
                            .flex()
                            .gap_3()
                            .child(div().text_size(px(18.)).child("Activity Monitor"))
                            .child(div().text_color(theme.muted()).child(status)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(control("learn", "Learn", theme, false).on_click(
                                cx.listener(|this, _, _, cx| this.show_surface(Surface::Learn, cx)),
                            ))
                            .child(control("computer", "Computer", theme, false).on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.show_surface(Surface::Computer, cx)
                                }),
                            ))
                            .child(
                                control(
                                    "interval",
                                    format!("Every {}s", self.request.interval),
                                    theme,
                                    false,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.request.interval = match this.request.interval {
                                            1 => 2,
                                            2 => 5,
                                            _ => 1,
                                        };
                                        this.submit();
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                control(
                                    "pause",
                                    if self.request.paused {
                                        "Resume"
                                    } else {
                                        "Pause"
                                    },
                                    theme,
                                    false,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.request.paused = !this.request.paused;
                                        this.submit();
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                control("close-monitor", "Close  ⌘W", theme, false).on_click(
                                    cx.listener(|_, _, _, cx| cx.emit(MonitorEvent::Close)),
                                ),
                            ),
                    ),
            )
            .child(overview)
            .child(
                div()
                    .px_4()
                    .pb_2()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(scopes)
                    .child(
                        control(
                            "tree",
                            if self.request.tree {
                                "Tree ▾"
                            } else {
                                "List"
                            },
                            theme,
                            self.request.tree,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.request.tree = !this.request.tree;
                            this.submit();
                            cx.notify();
                        })),
                    )
                    .child(
                        control("columns", "Columns", theme, self.show_columns).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.show_columns = !this.show_columns;
                                cx.notify();
                            }),
                        ),
                    ),
            )
            .when(self.show_columns, |d| {
                d.child(
                    div().px_4().pb_2().flex().flex_wrap().gap_2().children(
                        [
                            ("PID", Sort::Pid),
                            ("User", Sort::Owner),
                            ("CPU", Sort::Cpu),
                            ("Memory", Sort::Memory),
                            ("Threads", Sort::Threads),
                            ("State", Sort::State),
                        ]
                        .into_iter()
                        .map(|(label, column)| {
                            control(
                                gpui::SharedString::from(format!("column-{label}")),
                                label,
                                theme,
                                self.request.columns.contains(&column),
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if !this.request.columns.remove(&column) {
                                        this.request.columns.insert(column);
                                    }
                                    this.submit();
                                    cx.notify();
                                },
                            ))
                        }),
                    ),
                )
            })
            .child(
                div()
                    .px_4()
                    .pb_2()
                    .child(Input::new(&self.search).aria_label("Search processes or PID")),
            )
            .when_some(error, |d, error| {
                d.child(div().px_4().py_1().text_color(rgb(0xff7b72)).child(error))
            })
            .child(div().flex_1().min_h_0().child(table))
            .child(detail)
            .child(
                div()
                    .px_4()
                    .py_1()
                    .flex_shrink_0()
                    .text_color(theme.muted())
                    .child(
                        snapshot
                            .as_ref()
                            .map(|s| {
                                format!(
                                    "{} of {} processes · {} unavailable/partial · {:.0}s old",
                                    s.rows.len(),
                                    s.processes.len(),
                                    s.unavailable,
                                    s.sampled.elapsed().as_secs_f64()
                                )
                            })
                            .unwrap_or_else(|| "Starting monitor…".into()),
                    ),
            )
            .into_any_element()
    }
}
fn process_age(start: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let seconds = now.saturating_sub(start);
    if seconds >= 86400 {
        format!("{}d {}h", seconds / 86400, seconds % 86400 / 3600)
    } else if seconds >= 3600 {
        format!("{}h {}m", seconds / 3600, seconds % 3600 / 60)
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}
