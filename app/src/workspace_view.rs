//! Window workspace. Pane entities own sessions independently of visible layout.
use crate::{
    config::Config,
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
use gpui_kit::component::Selectable;
mod kit_smoke;
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type SessionKey = (TabId, PaneId);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Destination {
    Terminal,
    Files,
    Prompts,
    Activity,
    Learn,
    Computer,
    Controller,
    Settings,
}
impl Destination {
    const ALL: [(Self, &'static str); 7] = [
        (Self::Terminal, "Terminal"),
        (Self::Files, "Files"),
        (Self::Prompts, "Prompts"),
        (Self::Activity, "Activity"),
        (Self::Learn, "Learn"),
        (Self::Computer, "Computer"),
        (Self::Controller, "Controller"),
    ];
}
struct Session {
    pane: Entity<TerminalPane>,
    _observer: Subscription,
    shell_record: Option<i64>,
}
pub struct WorkspaceView {
    settings: Entity<crate::settings::Settings>,
    _settings_events: Subscription,
    show_settings: bool,
    pad_hub: Option<std::sync::Arc<gamepad::Hub>>,
    pad_devices: std::collections::BTreeMap<u64, gamepad::Device>,
    pad_device: Option<u64>,
    pad_error: Option<String>,
    pad_armed: bool,
    pad_active: bool,
    pad_activation: Option<Subscription>,
    pad_destination: Option<Destination>,
    activity_search: Entity<gpui_kit::component::input::InputState>,
    activity: Option<Entity<crate::activity::view::ActivityMonitor>>,
    activity_events: Option<Subscription>,
    show_activity: bool,
    controller: Option<Entity<crate::controller::Controller>>,
    controller_events: Option<Subscription>,
    show_controller: bool,
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
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut error = None;
        let config = Config::load().unwrap_or_else(|e| {
            error = Some(format!("{e:#}"));
            Config::default()
        });
        crate::ui::init(&config, cx);
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
            this.pad_hub.take();
            this.controller.take();
            this.activity.take();
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
        let pad_hub = match gamepad::Hub::spawn() {
            Ok((hub, mut events)) => {
                let hub = std::sync::Arc::new(hub);
                let weak = std::sync::Arc::downgrade(&hub);
                cx.spawn(async move |this, cx| {
                    while events.next().await.is_some() {
                        let Some(hub) = weak.upgrade() else {
                            break;
                        };
                        let update = hub.take();
                        if this
                            .update(cx, |this, cx| this.pad_update(update, cx))
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
                Some(hub)
            }
            Err(e) => {
                log::error!("controller input: {e}");
                None
            }
        };
        let prompt_panel = cx.new(|cx| crate::prompt_panel::PromptPanel::new(window, cx));
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
        let settings = cx.new(|cx| crate::settings::Settings::new(&config, window, cx));
        let settings_events = cx.subscribe(&settings, |this, _, _, cx| {
            this.navigate(Destination::Terminal, cx)
        });
        let mut this = Self {
            settings,
            _settings_events: settings_events,
            show_settings: false,
            pad_hub,
            pad_devices: Default::default(),
            pad_device: None,
            pad_error: None,
            pad_armed: false,
            pad_active: true,
            pad_activation: None,
            pad_destination: None,
            activity_search: cx.new(|cx| {
                gpui_kit::component::input::InputState::new(window, cx)
                    .placeholder("Search processes or PID")
            }),
            activity: None,
            activity_events: None,
            show_activity: false,
            controller: None,
            controller_events: None,
            show_controller: false,
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
        if self.show_activity || self.show_controller {
            return;
        }
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
        if action == "settings" {
            self.navigate(Destination::Settings, cx);
            return true;
        }
        if self.show_settings {
            if action == "close_pane" {
                self.navigate(Destination::Terminal, cx);
            }
            return true;
        }
        if self.show_controller {
            match action {
                "activity_monitor" => self.navigate(Destination::Activity, cx),
                "close_pane" => self.navigate(Destination::Terminal, cx),
                _ => {}
            }
            return true;
        }
        if action == "activity_monitor" {
            if self.show_activity {
                self.close_activity(cx);
            } else {
                self.open_activity(cx);
            }
            return true;
        }
        if self.show_activity {
            if action == "close_pane" {
                self.close_activity(cx);
            }
            // Monitor owns keyboard/controller input while open. Native Copy/
            // Paste route explicitly below; other terminal actions stay dormant.
            return true;
        }
        if self.show_prompts && action == "close_pane" {
            self.show_prompts = false;
            self.focus_active(cx);
            cx.notify();
            return true;
        }
        self.capture(cx);
        match action {
            "prompts" => {
                self.show_prompts = !self.show_prompts;
                if self.show_prompts {
                    self.prompt_panel.update(cx, |p, cx| p.focus(cx));
                } else {
                    self.focus_active(cx);
                }
                cx.notify();
                return true;
            }
            "send_next_prompt" => {
                self.prompt_panel.update(cx, |p, cx| p.send_next(cx));
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
    fn reset_pad(&mut self, cx: &mut Context<Self>) {
        self.pad_armed = self.pad_active
            && self
                .pad_device
                .and_then(|id| self.pad_devices.get(&id))
                .is_some_and(gamepad::Device::neutral);
        if let Some(m) = &self.activity {
            m.update(cx, |m, cx| {
                m.on_pad(gamepad::PadEvent::Disconnected(String::new()), cx);
                if self.pad_armed {
                    // The selected snapshot is already neutral. Re-arm the
                    // world's own stick gate before its next physical movement.
                    for stick in [gamepad::Stick::Left, gamepad::Stick::Right] {
                        m.on_pad(
                            gamepad::PadEvent::Stick {
                                stick,
                                x: 0.,
                                y: 0.,
                            },
                            cx,
                        );
                    }
                }
            });
        }
    }
    fn sync_controller(&self, events: &[(u64, gamepad::PadEvent)], cx: &mut Context<Self>) {
        if let Some(c) = &self.controller {
            c.update(cx, |c, cx| {
                c.input(
                    self.pad_devices.clone(),
                    self.pad_device,
                    self.pad_error.clone(),
                    events,
                    cx,
                )
            });
        }
    }
    fn pad_update(&mut self, update: gamepad::Update, cx: &mut Context<Self>) {
        let previous = self.pad_device;
        let inventory_changed = self.pad_devices.keys().collect::<Vec<_>>()
            != update.devices.keys().collect::<Vec<_>>();
        self.pad_devices = update.devices;
        self.pad_error = update.error;
        if self
            .pad_device
            .is_none_or(|id| !self.pad_devices.contains_key(&id))
        {
            self.pad_device = self.pad_devices.keys().next().copied();
        }
        let destination = self.destination(cx);
        let discard_edges = previous != self.pad_device || update.reset;
        if discard_edges || self.pad_destination != Some(destination) {
            self.reset_pad(cx);
            self.pad_destination = Some(destination);
        }
        self.pad_name = self
            .pad_device
            .and_then(|id| self.pad_devices.get(&id))
            .map(|d| d.name.clone());
        self.sync_controller(&update.events, cx);
        if inventory_changed {
            cx.notify();
        }
        if !self.pad_active {
            return;
        }
        let Some(device) = self
            .pad_device
            .and_then(|id| self.pad_devices.get(&id))
            .cloned()
        else {
            return;
        };
        if discard_edges {
            return;
        }
        if !self.pad_armed {
            self.pad_armed = device.neutral();
            return;
        }
        if self.show_controller || self.show_prompts || self.show_settings {
            return;
        }
        use crate::controller::profile::Surface;
        let surface = match destination {
            Destination::Terminal => Surface::Terminal,
            Destination::Files => Surface::Files,
            Destination::Learn => Surface::Learn,
            Destination::Computer => Surface::Computer,
            _ => return,
        };
        for (_, event) in update.events.into_iter().filter(|(id, _)| *id == device.id) {
            if let gamepad::PadEvent::Released(button) = event {
                let action = self.config.controller.action(surface, button);
                // Duplicate held assignments stay active until every source is released.
                if matches!(
                    action,
                    crate::controller::profile::Action::Ascend
                        | crate::controller::profile::Action::Descend
                ) && gamepad::PsButton::ALL.into_iter().any(|b| {
                    device.held & (1 << (b as u8)) != 0
                        && self.config.controller.action(surface, b) == action
                }) {
                    continue;
                }
            }
            if let Some(event) = self.config.controller.resolve(surface, event) {
                self.route_pad(event, cx);
            }
            if self.destination(cx) != destination {
                self.reset_pad(cx);
                return;
            }
        }
        for event in gamepad::stick_events(&device) {
            self.route_pad(event, cx);
        }
    }
    fn route_pad(&mut self, event: gamepad::PadEvent, cx: &mut Context<Self>) {
        match &event {
            gamepad::PadEvent::Connected(name) => self.pad_name = Some(name.clone()),
            gamepad::PadEvent::Disconnected(_) => self.pad_name = None,
            _ => {}
        }
        if let Some(m) = &self.activity {
            m.update(cx, |m, cx| m.on_pad(event.clone(), cx));
        }
        if !self.show_activity && !self.show_controller && !self.show_prompts && !self.show_settings
        {
            if let Some(pane) = self.active_pane() {
                pane.update(cx, |p, cx| p.on_pad(event, cx));
            }
        }
    }
    pub fn open_activity(&mut self, cx: &mut Context<Self>) {
        self.reset_pad(cx);
        if let Some(c) = &self.controller {
            c.update(cx, |c, cx| c.visible(false, cx));
        }
        self.show_controller = false;
        self.show_prompts = false;
        if self.activity.is_none() {
            let config = self.config.clone();
            let monitor = cx.new(|cx| {
                crate::activity::view::ActivityMonitor::new(
                    &config,
                    self.activity_search.clone(),
                    cx,
                )
            });
            self.activity_events = Some(cx.subscribe(&monitor, |this, _, event, cx| match event {
                crate::activity::view::MonitorEvent::SurfaceChanged => cx.notify(),
                crate::activity::view::MonitorEvent::Close => this.close_activity(cx),
                crate::activity::view::MonitorEvent::Reveal(root) => {
                    if this.sessions.get(&(root.tab, root.pane)).is_some_and(|s| {
                        s.pane.entity_id().as_u64() == root.token
                            && s.pane.read(cx).terminal.as_ref().and_then(|t| t.pid())
                                == Some(root.pid)
                    }) {
                        this.close_activity(cx);
                        this.activate((root.tab, root.pane), cx);
                    }
                }
            }));
            self.activity = Some(monitor);
        }
        self.show_activity = true;
        self.sync_activity(cx);
        if let Some(monitor) = &self.activity {
            monitor.update(cx, |m, cx| m.set_visible(true, cx));
        }
        cx.notify();
    }
    fn close_activity(&mut self, cx: &mut Context<Self>) {
        self.show_activity = false;
        if let Some(monitor) = &self.activity {
            monitor.update(cx, |m, cx| m.set_visible(false, cx));
        }
        self.focus_active(cx);
        cx.notify();
    }
    fn sync_activity(&self, cx: &mut Context<Self>) {
        if !self.show_activity {
            return;
        }
        if let Some(monitor) = &self.activity {
            let mut roots: Vec<_> = self
                .sessions
                .iter()
                .filter_map(|((tab, pane), session)| {
                    let p = session.pane.read(cx);
                    Some(crate::activity::model::ShellRoot {
                        tab: *tab,
                        pane: *pane,
                        token: session.pane.entity_id().as_u64(),
                        pid: p.terminal.as_ref()?.pid()?,
                        label: p.title.clone(),
                    })
                })
                .collect();
            roots.sort_by_key(|r| (r.tab, r.pane));
            let active = self.active_key();
            monitor.update(cx, |m, _| m.set_roots(roots, active));
        }
    }
    fn destination(&self, cx: &App) -> Destination {
        if self.show_settings {
            return Destination::Settings;
        }
        if self.show_controller {
            return Destination::Controller;
        }
        if self.show_activity {
            use crate::activity::view::Surface;
            return match self.activity.as_ref().unwrap().read(cx).surface() {
                Surface::Processes => Destination::Activity,
                Surface::Learn => Destination::Learn,
                Surface::Computer => Destination::Computer,
            };
        }
        if self.show_prompts {
            return Destination::Prompts;
        }
        if self.active_pane().is_some_and(|p| p.read(cx).is_explorer()) {
            Destination::Files
        } else {
            Destination::Terminal
        }
    }
    fn navigate(&mut self, destination: Destination, cx: &mut Context<Self>) {
        self.show_settings = destination == Destination::Settings;
        self.reset_pad(cx);
        if let Some(c) = &self.controller {
            c.update(cx, |c, cx| {
                c.visible(destination == Destination::Controller, cx)
            });
        }
        self.dragging_tab = None;
        self.split_drag = None;
        self.show_prompts = false;
        if matches!(
            destination,
            Destination::Activity | Destination::Learn | Destination::Computer
        ) {
            use crate::activity::view::Surface;
            self.open_activity(cx);
            let surface = match destination {
                Destination::Learn => Surface::Learn,
                Destination::Computer => Surface::Computer,
                _ => Surface::Processes,
            };
            self.activity
                .as_ref()
                .unwrap()
                .update(cx, |m, cx| m.show_surface(surface, cx));
        } else {
            self.show_controller = destination == Destination::Controller;
            if self.show_activity {
                self.close_activity(cx);
            }
            match destination {
                Destination::Settings => {
                    self.settings.update(cx, |settings, cx| settings.open(cx));
                }
                Destination::Controller => {
                    if self.controller.is_none() {
                        let config = self.config.clone();
                        let controller =
                            cx.new(|cx| crate::controller::Controller::new(&config, cx));
                        self.controller_events =
                            Some(cx.subscribe(&controller, |this, _, event, cx| {
                                use crate::controller::ControllerEvent;
                                match event {
                                    ControllerEvent::Back => {
                                        this.navigate(Destination::Terminal, cx)
                                    }
                                    ControllerEvent::SelectDevice(id) => {
                                        if this.pad_devices.contains_key(id) {
                                            this.pad_device = Some(*id);
                                            this.reset_pad(cx);
                                            this.sync_controller(&[], cx);
                                        }
                                    }
                                    ControllerEvent::Applied(profile) => {
                                        this.config.controller = profile.clone();
                                        this.reset_pad(cx);
                                    }
                                }
                            }));
                        self.controller = Some(controller);
                    }
                    self.sync_controller(&[], cx);
                    self.controller
                        .as_ref()
                        .unwrap()
                        .update(cx, |c, cx| c.focus(cx));
                }
                Destination::Prompts => {
                    self.show_prompts = true;
                    self.prompt_panel.update(cx, |p, cx| p.focus(cx));
                }
                Destination::Files | Destination::Terminal => {
                    if let Some(pane) = self.active_pane() {
                        pane.update(cx, |p, cx| {
                            if destination == Destination::Files {
                                p.show_explorer(cx);
                            } else {
                                p.show_terminal(cx);
                            }
                        });
                    }
                    self.focus_active(cx);
                    self.schedule_save(cx);
                }
                _ => {}
            }
        }
        cx.notify();
    }
    fn footer(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::from_config(&self.config);
        let selected = self.destination(cx);
        let mut bar = div()
            .id("surface-navigation")
            .px_1()
            .py_1()
            .gap_1()
            .w_full()
            .flex_shrink_0()
            .flex()
            .bg(theme.chrome())
            .text_color(theme.fg)
            .border_t_1()
            .border_color(theme.raised());
        for (index, (destination, label)) in Destination::ALL.into_iter().enumerate() {
            let active = destination == selected;
            bar = bar.child(
                crate::ui::button(("surface", index), label)
                    .flex_1()
                    .min_w_0()
                    .selected(active)
                    .tooltip(format!("{label} · ⌘⌥{}", index + 1))
                    .on_click(cx.listener(move |this, _, _, cx| this.navigate(destination, cx))),
            );
        }
        bar.into_any_element()
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        if self.show_prompts && key.key == "escape" {
            self.show_prompts = false;
            self.focus_active(cx);
            cx.stop_propagation();
            cx.notify();
            return;
        }
        // Native text fields own editing shortcuts; never forward them to PTYs.
        if gpui_kit::component::WindowExt::focused_input(window, cx).is_some()
            && self
                .config
                .action(key)
                .is_some_and(|a| matches!(a, "copy" | "paste"))
        {
            return;
        }
        if key.modifiers.platform
            && key.modifiers.alt
            && !key.modifiers.control
            && !key.modifiers.shift
        {
            if let Ok(index) = key.key.parse::<usize>() {
                if let Some((destination, _)) =
                    index.checked_sub(1).and_then(|i| Destination::ALL.get(i))
                {
                    self.navigate(*destination, cx);
                    cx.stop_propagation();
                    return;
                }
            }
        }
        if let Some(action) = self.config.action(key).map(str::to_string) {
            if self.action(&action, cx) {
                cx.stop_propagation();
            }
            return;
        }
        if key.modifiers.platform
            && !self.show_activity
            && !self.show_controller
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
        if self.pad_activation.is_none() {
            self.pad_active = window.is_window_active();
            self.pad_activation = Some(cx.observe_window_activation(window, |this, window, cx| {
                this.pad_active = window.is_window_active();
                this.reset_pad(cx);
            }));
        }
        let destination = self.destination(cx);
        if self.pad_destination != Some(destination) {
            self.reset_pad(cx);
            self.pad_destination = Some(destination);
        }
        self.sync_activity(cx);
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
            ("activity", "Activity", "activity_monitor"),
            ("settings", "Settings", "settings"),
        ] {
            tabs = tabs.child(
                crate::ui::button(id, label)
                    .tooltip(action.replace('_', " "))
                    .accessibility_label(action.replace('_', " "))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.action(action, cx);
                    })),
            );
        }
        let footer = self.footer(cx);
        let body = if self.show_settings {
            self.settings.clone().into_any_element()
        } else if self.show_controller {
            self.controller.clone().unwrap().into_any_element()
        } else if self.show_activity {
            self.activity.clone().unwrap().into_any_element()
        } else if let Some(tab) = self.workspace.active() {
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
            .on_action(cx.listener(|this, _: &crate::menus::Copy, window, cx| {
                if gpui_kit::component::WindowExt::focused_input(window, cx).is_some() {
                    window.dispatch_action(Box::new(gpui_kit::component::input::Copy), cx);
                } else if this.show_activity {
                    if let Some(m) = &this.activity {
                        m.update(cx, |m, cx| m.clipboard("copy", window, cx));
                    }
                } else {
                    this.action("copy", cx);
                }
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Paste, window, cx| {
                if gpui_kit::component::WindowExt::focused_input(window, cx).is_some() {
                    window.dispatch_action(Box::new(gpui_kit::component::input::Paste), cx);
                } else if this.show_activity {
                    if let Some(m) = &this.activity {
                        m.update(cx, |m, cx| m.clipboard("paste", window, cx));
                    }
                } else {
                    this.action("paste", cx);
                }
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Flip, _, cx| {
                this.action("flip", cx);
            }))
            .on_action(cx.listener(|this, _: &crate::menus::Prompts, _, cx| {
                this.action("prompts", cx);
            }))
            .on_action(
                cx.listener(|this, _: &crate::menus::ActivityMonitor, _, cx| {
                    this.action("activity_monitor", cx);
                }),
            )
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
            .when(
                !self.show_activity && !self.show_controller && !self.show_settings,
                |d| d.child(tabs),
            )
            .when_some(self.error.clone(), |d, error| {
                d.child(div().px_2().py_1().text_color(rgb(0xff7b72)).child(error))
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(div().flex_1().min_w_0().h_full().child(body))
                    .when(
                        self.show_prompts
                            && !self.show_activity
                            && !self.show_controller
                            && !self.show_settings,
                        |d| d.child(self.prompt_panel.clone()),
                    ),
            )
            .child(footer)
    }
}

impl WorkspaceView {
    pub fn open_prompts(&mut self, cx: &mut Context<Self>) {
        self.navigate(Destination::Prompts, cx);
    }
    pub fn open_settings(&mut self, cx: &mut Context<Self>) {
        self.navigate(Destination::Settings, cx);
    }
    pub fn open_controller(&mut self, cx: &mut Context<Self>) {
        self.navigate(Destination::Controller, cx);
    }
    pub fn start_controller_smoke(&mut self, cx: &mut Context<Self>) {
        assert!(
            std::env::var_os("TBIAS_DATA_DIR").is_some(),
            "controller smoke requires isolated data"
        );
        self.pad_hub.take(); // Synthetic devices exclusively own this isolated fixture.
        self.active_pane().unwrap().update(cx, |p, cx| {
            p.paste("printf '%s%s\\n' CONTROLLER_ READY", cx);
            p.smoke_enter(cx);
        });
        cx.spawn(async move |this,cx| {
            let mut before=String::new();let mut hidden_frames=0;let mut camera=None;
            for step in 0..29 {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                this.update(cx,|this,cx| {
                    let fixture=|held,events|gamepad::Update {
                        devices:[(1000,gamepad::Device{id:1000,name:"Smoke controller".into(),mapping:"Synthetic fixture".into(),supported:0xffff,axes:[true;4],held,sticks:[0.;4]})].into_iter().collect(),
                        events,error:None,reset:false,
                    };
                    let terminal_text=|this:&Self,cx:&App| {
                        let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                        let text=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect::<String>();text
                    };
                    match step {
                        3=>{before=terminal_text(this,cx);assert!(before.contains("CONTROLLER_READY"));this.open_controller(cx);this.pad_update(fixture(0,vec![]),cx);}
                        9=>{assert!(this.controller.as_ref().unwrap().read(cx).smoke_ready(),"wgpu frame not displayed");this.controller.as_ref().unwrap().update(cx,|c,cx|c.smoke_capture(cx));}
                        10=>this.pad_update(fixture(1<<1,vec![(1000,gamepad::PadEvent::Pressed(gamepad::PsButton::Circle))]),cx),
                        11=>{this.pad_update(fixture(0,vec![(1000,gamepad::PadEvent::Released(gamepad::PsButton::Circle))]),cx);assert!(this.controller.as_ref().unwrap().read(cx).smoke_captured());assert_eq!(before,terminal_text(this,cx),"capture leaked to PTY");this.controller.as_ref().unwrap().update(cx,|c,cx|c.smoke_edit(cx));}
                        13=>{
                            use crate::controller::profile::{Surface,Action};
                            assert_eq!(this.config.controller.action(Surface::Terminal,gamepad::PsButton::Circle),Action::Enter);
                            assert_eq!(Config::load().unwrap().controller,this.config.controller);
                            this.navigate(Destination::Terminal,cx);
                            this.active_pane().unwrap().update(cx,|p,cx|p.paste("printf '%s%s\\n' CONTROLLER_ REMAPPED",cx));
                        }
                        14=>{assert!(this.pad_active,"smoke window lost focus");this.pad_update(fixture(1<<1,vec![(1000,gamepad::PadEvent::Pressed(gamepad::PsButton::Circle))]),cx);}
                        15=>this.pad_update(fixture(0,vec![(1000,gamepad::PadEvent::Released(gamepad::PsButton::Circle))]),cx),
                        18=>{assert!(terminal_text(this,cx).contains("CONTROLLER_REMAPPED"),"remapped Circle did not submit Enter");this.open_controller(cx);}
                        21=>{this.navigate(Destination::Computer,cx);hidden_frames=this.controller.as_ref().unwrap().read(cx).rendered_frames;}
                        22=>{
                            camera=Some(this.activity.as_ref().unwrap().read(cx).smoke_camera(cx).0);
                            let mut moving=fixture(0,vec![]);
                            moving.devices.get_mut(&1000).unwrap().sticks=[0.7,0.4,0.,0.];
                            this.pad_update(moving,cx);
                        }
                        24=>{
                            assert_ne!(camera.unwrap(),this.activity.as_ref().unwrap().read(cx).smoke_camera(cx).0,"first stick movement after navigation was ignored");
                            this.pad_update(fixture(0,vec![]),cx);
                            this.navigate(Destination::Terminal,cx);
                        }
                        26=>{assert_eq!(hidden_frames,this.controller.as_ref().unwrap().read(cx).rendered_frames,"hidden controller rendered new frames");log::info!("CONTROLLER_SMOKE_OK: embedded wgpu frame, capture/release, zero PTY leakage, saved remap dispatch, first stick movement after navigation, hidden rendering paused");}
                        _=>{}
                    }
                }).unwrap();
            }
            let _=cx.update(|cx|cx.quit());
        }).detach();
    }
    pub fn start_activity_smoke(&mut self, cx: &mut Context<Self>) {
        assert!(
            std::env::var_os("TBIAS_DATA_DIR").is_some(),
            "activity smoke requires isolated data"
        );
        // This fixture injects its own stick input; attached hardware must not
        // overwrite it with neutral/drift snapshots from the polling thread.
        self.pad_hub.take();
        let key = self.active_key().unwrap();
        let pid = self
            .active_pane()
            .unwrap()
            .read(cx)
            .terminal
            .as_ref()
            .unwrap()
            .pid();
        self.active_pane().unwrap().update(cx, |p, cx| {
            p.paste("sleep 30", cx);
            p.smoke_enter(cx);
        });
        self.open_activity(cx);
        cx.spawn(async move |this, cx| {
            let mut camera = None;
            let mut terminal_text = String::new();
            for step in 0..37 {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                this.update(cx, |this, cx| {
                    if step == 8 {
                        assert!(this.activity.as_ref().unwrap().read(cx).smoke_ready(), "monitor did not collect live processes and shell associations");
                        this.activity.as_ref().unwrap().update(cx, |m, cx| m.smoke_filter(cx));
                        let count = this.sessions.len();
                        this.action("new_tab", cx);
                        this.action("send_next_prompt", cx);
                        assert_eq!(this.sessions.len(), count, "monitor leaked a terminal action");
                    }
                    if step == 12 {
                        assert!(this.activity.as_ref().unwrap().read(cx).smoke_filtered());
                        this.action("close_pane", cx);
                        assert!(!this.show_activity);
                        assert_eq!(this.active_key(), Some(key));
                        assert_eq!(this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().pid(), pid);
                        this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().handle().input(vec![3]);
                    }
                    if step == 13 {
                        this.active_pane().unwrap().update(cx, |p, cx| { p.paste("printf '%s%s\\n' ACTIVITY_ RETURNED", cx); p.smoke_enter(cx); });
                    }
                    if step == 15 {
                        let pane = this.active_pane().unwrap();
                        let h = pane.read(cx).terminal.as_ref().unwrap().handle();
                        let text: String = h.term().lock().grid().display_iter().map(|c| c.cell.c).collect();
                        assert!(text.contains("ACTIVITY_RETURNED"));
                        terminal_text = text;
                    }
                    if step == 16 {
                        this.open_activity(cx);
                        this.activity.as_ref().unwrap().update(cx, |m,cx|m.smoke_learning(cx));
                    }
                    if step == 18 {
                        this.activity.as_ref().unwrap().update(cx, |m,cx|m.smoke_computer(cx));
                        camera=Some(this.activity.as_ref().unwrap().read(cx).smoke_camera(cx).0);
                    }
                    if step == 19 {
                        // Simulate the centered snapshot required after entering
                        // a surface, then exercise held motion and release.
                        for stick in [gamepad::Stick::Left,gamepad::Stick::Right] {
                            this.route_pad(gamepad::PadEvent::Stick {stick,x:0.,y:0.},cx);
                        }
                        this.route_pad(gamepad::PadEvent::Stick {stick:gamepad::Stick::Left,x:1.,y:0.5},cx);
                    }
                    if step == 20 {
                        assert_ne!(camera.unwrap(),this.activity.as_ref().unwrap().read(cx).smoke_camera(cx).0);
                        this.route_pad(gamepad::PadEvent::Stick {stick:gamepad::Stick::Left,x:0.,y:0.},cx);
                        camera=Some(this.activity.as_ref().unwrap().read(cx).smoke_camera(cx).0);
                    }
                    if step == 21 {
                        let now=this.activity.as_ref().unwrap().read(cx).smoke_camera(cx);
                        assert_eq!(camera.unwrap(),now.0);assert!(!now.1,"neutral input left flight moving");
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Triangle),cx);
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Circle),cx);
                        this.activity.as_ref().unwrap().update(cx,|m,cx|m.smoke_table(cx));
                    }
                    if step == 24 {
                        let prefs=crate::activity::preferences::load(&crate::db::default_db_path().unwrap()).unwrap();
                        assert!(prefs.tree);assert_eq!(prefs.sort,crate::activity::model::Sort::Memory);
                        let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                        let text:String=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect();
                        assert_eq!(terminal_text,text,"course/world controller input reached the terminal");
                        log::info!("ACTIVITY_SMOKE_OK: live metrics, child job scope, terminal restore, embedded lessons, 3D rendering, controller flight/neutral/reset/back, preference persistence, no PTY leakage");
                    }
                    if step == 25 { this.navigate(Destination::Terminal, cx); }
                    if step == 26 {
                        this.navigate(Destination::Files, cx);
                        assert_eq!(this.destination(cx), Destination::Files);
                    }
                    if step == 27 { this.navigate(Destination::Terminal, cx); this.navigate(Destination::Prompts, cx); }
                    if step == 28 {
                        assert_eq!(this.destination(cx), Destination::Prompts);
                        let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                        terminal_text=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect();
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Cross),cx);
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Triangle),cx);
                    }
                    if step == 29 {
                        let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                        let text:String=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect();
                        assert_eq!(terminal_text,text,"prompt navigation leaked controller input");
                        this.navigate(Destination::Learn,cx);
                        assert_eq!(this.destination(cx),Destination::Learn);
                    }
                    if step == 30 {
                        let active=this.activity.as_ref().unwrap().read(cx).smoke_input_active();
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Circle),cx);
                        if !active {
                            assert_eq!(this.destination(cx),Destination::Learn,"inactive lesson consumed input");
                            // Exercise the same destination change as the Back button
                            // even if the user has focused another application.
                            this.activity.as_ref().unwrap().update(cx,|m,cx|m.show_surface(crate::activity::view::Surface::Processes,cx));
                        }
                        assert_eq!(this.destination(cx),Destination::Activity,"footer did not follow nested Back");
                        this.navigate(Destination::Computer,cx);
                        assert_eq!(this.destination(cx),Destination::Computer);
                    }
                    if step == 31 { this.navigate(Destination::Controller,cx); }
                    if step == 32 {
                        assert_eq!(this.destination(cx),Destination::Controller);
                        assert!(!this.show_activity);
                        let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                        terminal_text=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect();
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Cross),cx);
                        this.route_pad(gamepad::PadEvent::Pressed(gamepad::PsButton::Triangle),cx);
                        this.action("new_tab",cx);
                    }
                    if step == 34 {
                        let pane=this.active_pane().unwrap();let h=pane.read(cx).terminal.as_ref().unwrap().handle();
                        let text:String=h.term().lock().grid().display_iter().map(|c|c.cell.c).collect();
                        assert_eq!(terminal_text,text,"controller roadmap leaked input to PTY");
                        this.navigate(Destination::Terminal,cx);
                    }
                    if step == 35 {
                        assert_eq!(this.destination(cx),Destination::Terminal);
                        assert_eq!(this.active_key(),Some(key));
                        assert_eq!(this.sessions.len(),1);
                        assert_eq!(this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().pid(),pid);
                        log::info!("NAVIGATION_SMOKE_OK: all seven destinations, nested Back, preserved shell, prompt/controller input isolation");
                    }
                    if step == 36 && std::env::var_os("TBIAS_SMOKE_KEEP_OPEN").is_some() {
                        this.navigate(Destination::Controller,cx);
                    }
                }).expect("activity smoke window disappeared");
            }
            if std::env::var_os("TBIAS_SMOKE_KEEP_OPEN").is_none() { let _ = cx.update(|cx| cx.quit()); }
        }).detach();
    }
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
                            let clipboard=cx.read_from_clipboard();pane.update(cx,|p,cx|p.smoke_copy("SMOKE_READY",cx));cx.write_to_clipboard(clipboard.unwrap_or_else(||gpui::ClipboardItem::new_string(String::new())));
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
                        9=>{this.action("close_pane",cx);assert!(!this.show_prompts);assert_eq!(this.sessions.len(),4,"closing prompts closed a shell");this.action("close_pane",cx);assert_eq!(this.sessions.len(),3);}
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
