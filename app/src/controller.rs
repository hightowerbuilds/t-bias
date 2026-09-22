//! Native mapping editor with an offscreen wgpu illustration.
pub mod profile;
pub mod renderer;
use crate::{
    config::Config,
    gamepad::{Device, PadEvent, PsButton},
    terminal_view::Theme,
};
use futures::StreamExt;
use gpui::{
    div, prelude::*, px, rgb, Bounds, Context, EventEmitter, FocusHandle, MouseButton, Pixels,
    RenderImage, ScrollHandle, Subscription, Window,
};
use profile::{Action, Profile, Surface};
use std::{cell::Cell, collections::BTreeMap, rc::Rc, sync::Arc, time::Duration};

pub enum ControllerEvent {
    Back,
    SelectDevice(u64),
    Applied(Profile),
}
pub struct Controller {
    focus: FocusHandle,
    focus_requested: bool,
    scroll: ScrollHandle,
    theme: Theme,
    visible: bool,
    active: bool,
    activation: Option<Subscription>,
    renderer: Option<renderer::Renderer>,
    image: Option<Arc<RenderImage>>,
    retired: Vec<Arc<RenderImage>>,
    render_error: Option<String>,
    pub rendered_frames: u64,
    scene: renderer::Scene,
    geometry: Rc<Cell<Option<Bounds<Pixels>>>>,
    devices: BTreeMap<u64, Device>,
    device: Option<u64>,
    input_error: Option<String>,
    surface: Surface,
    saved: Profile,
    draft: Profile,
    baseline: Option<String>,
    message: String,
    capture: bool,
    capture_release: Option<PsButton>,
    capture_generation: u64,
    test: bool,
    preview: String,
}
impl EventEmitter<ControllerEvent> for Controller {}
impl Controller {
    pub fn new(config: &Config, cx: &mut Context<Self>) -> Self {
        let (renderer, events, error) = match renderer::Renderer::new() {
            Ok((r, e)) => (Some(r), Some(e), None),
            Err(e) => (None, None, Some(e.to_string())),
        };
        if let Some(mut events) = events {
            cx.spawn(async move |this, cx| {
                while events.next().await.is_some() {
                    if this
                        .update(cx, |this, cx| {
                            if let Some(result) =
                                this.renderer.as_ref().and_then(renderer::Renderer::take)
                            {
                                match result {
                                    Ok(frame) if this.visible && this.active => {
                                        if let Some(buffer) = image::RgbaImage::from_raw(
                                            frame.width,
                                            frame.height,
                                            frame.pixels,
                                        ) {
                                            let image =
                                                Arc::new(RenderImage::new([image::Frame::new(
                                                    buffer,
                                                )]));
                                            if let Some(old) = this.image.replace(image) {
                                                this.retired.push(old);
                                            }
                                            this.rendered_frames += 1;
                                            cx.notify();
                                        }
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        this.render_error = Some(e);
                                        cx.notify();
                                    }
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
        Self {
            focus: cx.focus_handle(),
            focus_requested: true,
            scroll: ScrollHandle::new(),
            theme: Theme::from_config(config),
            visible: false,
            active: true,
            activation: None,
            renderer,
            image: None,
            retired: vec![],
            render_error: error,
            rendered_frames: 0,
            scene: Default::default(),
            geometry: Rc::new(Cell::new(None)),
            devices: BTreeMap::new(),
            device: None,
            input_error: None,
            surface: Surface::Terminal,
            saved: config.controller.clone(),
            draft: config.controller.clone(),
            baseline: crate::config::path()
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok()),
            message: "Select a control to inspect or change its action.".into(),
            capture: false,
            capture_release: None,
            capture_generation: 0,
            test: false,
            preview: "Press a button to preview its draft action here.".into(),
        }
    }
    pub fn focus(&mut self, cx: &mut Context<Self>) {
        self.visible = true;
        self.focus_requested = true;
        self.submit();
        cx.notify();
    }
    pub fn visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.visible != visible {
            self.visible = visible;
            self.cancel_capture();
            self.test = false;
            self.scene.hovered = None;
            self.submit();
            cx.notify();
        }
    }
    fn cancel_capture(&mut self) {
        self.capture = false;
        self.capture_release = None;
        self.capture_generation += 1;
    }
    fn submit(&self) {
        if let Some(r) = &self.renderer {
            r.request((self.visible && self.active).then(|| self.scene.clone()));
        }
    }
    pub fn input(
        &mut self,
        devices: BTreeMap<u64, Device>,
        device: Option<u64>,
        error: Option<String>,
        events: &[(u64, PadEvent)],
        cx: &mut Context<Self>,
    ) {
        let changed = self.devices != devices || self.device != device || self.input_error != error;
        if self.device != device || device.is_none() {
            self.cancel_capture();
        }
        self.devices = devices;
        self.device = device;
        self.input_error = error;
        let current = device.and_then(|id| self.devices.get(&id));
        self.scene.pressed = current.map_or(0, |d| d.held);
        self.scene.sticks = current.map_or([0.; 4], |d| d.sticks);
        self.scene.supported = current.map_or(0xffff, |d| d.supported);
        if self.visible && self.active {
            for (_, event) in events.iter().filter(|(id, _)| Some(*id) == device) {
                match event {
                    PadEvent::Pressed(b) if self.capture && self.capture_release.is_none() => {
                        self.scene.selected = *b as usize;
                        self.capture_release = Some(*b);
                        self.message =
                            format!("{} selected. Release it to finish capture.", b.label());
                    }
                    PadEvent::Released(b) if self.capture_release == Some(*b) => {
                        self.cancel_capture();
                        self.message = "Control captured. Choose an action below.".into();
                    }
                    PadEvent::Pressed(b) if self.test && !self.capture => {
                        self.preview = format!(
                            "{} → {} · {}",
                            b.label(),
                            self.draft.action(self.surface, *b).label(),
                            self.surface.label()
                        );
                    }
                    _ => {}
                }
            }
            self.submit();
            if changed || !events.is_empty() {
                cx.notify();
            }
        }
    }
    fn capture(&mut self, cx: &mut Context<Self>) {
        if !self
            .device
            .and_then(|id| self.devices.get(&id))
            .is_some_and(Device::neutral)
        {
            self.message = "Connect a controller and release its controls before capture.".into();
            cx.notify();
            return;
        }
        self.cancel_capture();
        self.capture = true;
        self.test = false;
        self.message = "Press a button, then release it. Escape cancels.".into();
        let generation = self.capture_generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(10))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.capture_generation == generation && this.capture {
                    this.cancel_capture();
                    this.message = "Capture timed out. Your mappings were not changed.".into();
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
    fn apply(&mut self, cx: &mut Context<Self>) {
        let result = (|| -> anyhow::Result<String> {
            let baseline = self
                .baseline
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("Read the saved configuration before applying."))?;
            profile::save(&crate::config::path()?, baseline, &self.draft)
        })();
        match result {
            Ok(text) => {
                self.baseline = Some(text);
                self.saved = self.draft.clone();
                self.cancel_capture();
                self.test = false;
                self.message =
                    "Mappings saved and active. Release controls before returning.".into();
                cx.emit(ControllerEvent::Applied(self.saved.clone()));
            }
            Err(e) => self.message = format!("Could not apply: {e:#}"),
        }
        cx.notify();
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        let result = (|| -> anyhow::Result<(String, Profile)> {
            let text = std::fs::read_to_string(crate::config::path()?)?;
            let config = Config::parse(&text)?;
            Ok((text, config.controller))
        })();
        match result {
            Ok((text, p)) => {
                self.baseline = Some(text);
                self.saved = p.clone();
                self.draft = p.clone();
                self.cancel_capture();
                self.test = false;
                self.message = "Saved mappings reloaded; draft discarded.".into();
                cx.emit(ControllerEvent::Applied(p));
            }
            Err(e) => self.message = format!("Could not reload: {e:#}"),
        }
        cx.notify();
    }
    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        self.scene.selected = index;
        self.submit();
        cx.notify();
    }
    fn at(&self, pos: gpui::Point<Pixels>) -> Option<usize> {
        let b = self.geometry.get()?;
        renderer::hit(
            f32::from(pos.x - b.origin.x) / f32::from(b.size.width) * 1000.,
            f32::from(pos.y - b.origin.y) / f32::from(b.size.height) * 580.,
        )
    }
    fn key(&mut self, e: &gpui::KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        if k.modifiers.platform && k.key == "s" {
            self.apply(cx);
            cx.stop_propagation();
            return;
        }
        if k.modifiers.platform || k.modifiers.control || k.modifiers.alt {
            return;
        }
        match k.key.as_str() {
            "pageup" | "pagedown" | "home" => {
                let mut offset = self.scroll.offset();
                if k.key == "home" {
                    offset.y = px(0.);
                } else {
                    let direction = if k.key == "pageup" { 1. } else { -1. };
                    offset.y += (window.viewport_size().height - px(160.)) * direction;
                }
                self.scroll.set_offset(offset);
            }
            "escape" => {
                if self.capture {
                    self.cancel_capture();
                    self.message = "Capture canceled.".into();
                } else if self.test {
                    self.test = false;
                } else {
                    cx.emit(ControllerEvent::Back);
                }
            }
            "left" | "up" => self.select((self.scene.selected + 15) % 16, cx),
            "right" | "down" | "tab" => self.select(
                (self.scene.selected + if k.modifiers.shift { 15 } else { 1 }) % 16,
                cx,
            ),
            "enter" | "space" => self.cycle_action(1, cx),
            "[" => self.cycle_action(-1, cx),
            "]" => self.cycle_action(1, cx),
            "1" | "2" | "3" | "4" => {
                self.surface = Surface::ALL[k.key.parse::<usize>().unwrap() - 1];
                self.cancel_capture();
                self.test = false;
            }
            "c" => self.capture(cx),
            "t" => {
                self.cancel_capture();
                self.test = !self.test;
            }
            "d" => {
                self.draft = self.saved.clone();
                self.cancel_capture();
                self.message = "Draft discarded.".into();
            }
            "r" => self.reload(cx),
            "backspace" => {
                self.draft.bindings.remove(&self.surface);
                self.message = "Surface defaults restored in draft.".into();
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
    fn cycle_action(&mut self, delta: isize, cx: &mut Context<Self>) {
        let b = PsButton::ALL[self.scene.selected];
        let choices = Action::choices(self.surface);
        let i = choices
            .iter()
            .position(|a| *a == self.draft.action(self.surface, b))
            .unwrap_or(0);
        let next = (i as isize + delta).rem_euclid(choices.len() as isize) as usize;
        self.draft.set(self.surface, b, choices[next]);
        self.message = "Draft updated. Apply saves it; Discard restores saved mappings.".into();
        cx.notify();
    }
    pub fn smoke_edit(&mut self, cx: &mut Context<Self>) {
        self.draft
            .set(Surface::Terminal, PsButton::Circle, Action::Enter);
        self.apply(cx);
    }
    pub fn smoke_ready(&self) -> bool {
        self.rendered_frames > 0 && self.render_error.is_none()
    }
    pub fn smoke_capture(&mut self, cx: &mut Context<Self>) {
        self.capture(cx);
        assert!(self.capture);
    }
    pub fn smoke_captured(&self) -> bool {
        self.scene.selected == PsButton::Circle as usize && !self.capture
    }
}
fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<gpui::SharedString>,
    chosen: bool,
) -> gpui_kit::component::button::Button {
    use gpui_kit::component::Selectable;
    crate::ui::button(id, label).selected(chosen)
}
impl Render for Controller {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.activation.is_none() {
            self.active = window.is_window_active();
            self.activation = Some(cx.observe_window_activation(window, |this, window, cx| {
                this.active = window.is_window_active();
                this.cancel_capture();
                this.test = false;
                this.submit();
                cx.notify();
            }));
        }
        if self.focus_requested {
            window.focus(&self.focus, cx);
            self.focus_requested = false;
        }
        for image in self.retired.drain(..) {
            let _ = window.drop_image(image);
        }
        let width = f32::from(window.viewport_size().width);
        let wide = width >= 1000.;
        let scene_width = if wide { width - 372. } else { width - 48. };
        let scene_height = if f32::from(window.viewport_size().height) < 600. {
            200.
        } else {
            (scene_width * 0.58).clamp(200., 480.)
        };
        self.scene.width = (scene_width * window.scale_factor()).round() as u32;
        self.scene.width = self.scene.width.clamp(320, 1400);
        self.submit();
        let image = self.image.clone();
        let geometry = self.geometry.clone();
        let picture = gpui::canvas(
            move |bounds, _, _| {
                let ratio = 1000. / 580.;
                let w = f32::from(bounds.size.width).min(f32::from(bounds.size.height) * ratio);
                let h = w / ratio;
                let fit = Bounds::new(
                    gpui::point(
                        bounds.origin.x + (bounds.size.width - px(w)) / 2.,
                        bounds.origin.y + (bounds.size.height - px(h)) / 2.,
                    ),
                    gpui::size(px(w), px(h)),
                );
                geometry.set(Some(fit));
                fit
            },
            move |_, fit, window, cx| {
                if let Some(image) = &image {
                    let _ = window.paint_image(
                        fit,
                        fit,
                        gpui::Corners::all(px(0.)),
                        image.clone(),
                        0,
                        false,
                    );
                }
                for (x, y, label) in [
                    (265., 111., "L2"),
                    (735., 111., "R2"),
                    (265., 150., "L1"),
                    (735., 150., "R1"),
                    (385., 430., "L3"),
                    (615., 430., "R3"),
                    (449., 242., "SELECT"),
                    (551., 242., "START"),
                    (500., 306., "ANALOG"),
                ] {
                    let text: gpui::SharedString = label.into();
                    let size = px((f32::from(fit.size.width) / 1000. * 13.).max(9.));
                    let shaped = window.text_system().shape_line(
                        text.clone(),
                        size,
                        &[gpui::TextRun {
                            len: text.len(),
                            font: gpui::font("Menlo"),
                            color: rgb(0x9eb0c2).into(),
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        }],
                        None,
                    );
                    let origin = gpui::point(
                        fit.origin.x + fit.size.width * (x / 1000.) - shaped.width / 2.,
                        fit.origin.y + fit.size.height * (y / 580.) - size / 2.,
                    );
                    let _ =
                        shaped.paint(origin, size * 1.2, gpui::TextAlign::Left, None, window, cx);
                }
            },
        )
        .size_full();
        let map = div()
            .id("controller-map")
            .relative()
            .w_full()
            .h(px(scene_height))
            .flex_shrink_0()
            .rounded_lg()
            .overflow_hidden()
            .bg(rgb(0x0b1117))
            .cursor_pointer()
            .on_mouse_move(cx.listener(|this, e: &gpui::MouseMoveEvent, _, cx| {
                let hit = this.at(e.position);
                if this.scene.hovered != hit {
                    this.scene.hovered = hit;
                    this.submit();
                    cx.notify();
                }
            }))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !hovered {
                    this.scene.hovered = None;
                    this.submit();
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &gpui::MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    if let Some(i) = this.at(e.position) {
                        this.select(i, cx);
                    }
                }),
            )
            .child(picture)
            .when(self.image.is_none(), |d| {
                d.child(
                    div()
                        .absolute()
                        .p_4()
                        .child(if self.render_error.is_some() {
                            "Controller illustration unavailable. The control list is still usable."
                        } else {
                            "Preparing controller illustration…"
                        }),
                )
            });
        let selected = PsButton::ALL[self.scene.selected];
        let action = self.draft.action(self.surface, selected);
        let supported = self
            .device
            .and_then(|id| self.devices.get(&id))
            .map(|d| d.supported & (1 << self.scene.selected) != 0);
        let mut controls = div().flex().flex_wrap().gap_2();
        for (i, b) in PsButton::ALL.iter().enumerate() {
            let b = *b;
            let pressed = self.scene.pressed & (1 << i) != 0;
            controls = controls.child(
                button(
                    ("control", i),
                    format!("{}{}", if pressed { "● " } else { "" }, b.label()),
                    self.scene.selected == i,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    window.focus(&this.focus, cx);
                    this.select(i, cx);
                })),
            );
        }
        let mut actions = div()
            .id("controller-actions")
            .h(px(150.))
            .flex_shrink_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_1();
        for (i, a) in Action::choices(self.surface).iter().enumerate() {
            let a = *a;
            actions = actions.child(
                button(("action", i), a.label(), a == action)
                    .flex_shrink_0()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.draft
                            .set(this.surface, PsButton::ALL[this.scene.selected], a);
                        this.message = "Draft updated. Apply to save and activate.".into();
                        cx.notify();
                    })),
            );
        }
        let inspector = div()
            .when(wide, |d| d.w(px(292.)).flex_shrink_0())
            .when(!wide, |d| d.w_full())
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded_lg()
            .bg(self.theme.chrome())
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(self.theme.muted())
                    .child("SELECTED CONTROL"),
            )
            .child(div().text_size(px(24.)).child(selected.label()))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(self.theme.muted())
                    .child(match supported {
                        None => "Layout preview · no device connected",
                        Some(true) => {
                            if self.scene.pressed & (1 << self.scene.selected) != 0 {
                                "Pressed"
                            } else {
                                "Released"
                            }
                        }
                        Some(false) => "Not reported by this device",
                    }),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .child(format!("{} action", self.surface.label())),
            )
            .child(actions)
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(self.theme.muted())
                    .child(
                        if action == profile::default_action(self.surface, selected) {
                            "Default assignment"
                        } else {
                            "Custom assignment"
                        },
                    ),
            )
            .child(
                button(
                    "capture-control",
                    if self.capture {
                        "Listening…"
                    } else {
                        "Press a control to select"
                    },
                    self.capture,
                )
                .on_click(cx.listener(|this, _, _, cx| this.capture(cx))),
            )
            .child(
                button(
                    "test-controller",
                    if self.test {
                        "Stop draft test"
                    } else {
                        "Test draft mappings"
                    },
                    self.test,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.cancel_capture();
                    this.test = !this.test;
                    cx.notify();
                })),
            )
            .when(self.test, |d| {
                d.child(div().text_size(px(12.)).child(self.preview.clone()))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(self.theme.muted())
                            .child("Preview only. No commands or flight actions execute here."),
                    )
            });
        let mut devices = div().flex().flex_shrink_0().flex_wrap().gap_2();
        for (id, d) in &self.devices {
            let id = *id;
            devices = devices.child(
                button(
                    ("device", id as usize),
                    d.name.clone(),
                    self.device == Some(id),
                )
                .on_click(
                    cx.listener(move |_, _, _, cx| cx.emit(ControllerEvent::SelectDevice(id))),
                ),
            );
        }
        let device_label = if let Some(e) = &self.input_error {
            e.clone()
        } else if self.devices.is_empty() {
            "No controller connected · explore and edit the layout below".into()
        } else {
            self.device
                .and_then(|id| self.devices.get(&id))
                .map(|d| format!("{} · {} mapping · device {}", d.name, d.mapping, d.id))
                .unwrap_or_else(|| "Select a connected device".into())
        };
        let mut surfaces = div().flex().flex_shrink_0().flex_wrap().gap_2();
        for (i, s) in Surface::ALL.into_iter().enumerate() {
            surfaces = surfaces.child(
                button(("profile-surface", i), s.label(), s == self.surface).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.surface = s;
                        this.cancel_capture();
                        this.test = false;
                        cx.notify();
                    },
                )),
            );
        }
        let dirty = self.draft != self.saved;
        div().id("controller-editor").size_full().min_h_0().track_focus(&self.focus).on_key_down(cx.listener(Self::key)).bg(self.theme.bg).text_color(self.theme.fg).flex().flex_col()
            .child(div().id("controller-scroll").flex_1().min_h_0().overflow_y_scroll().track_scroll(&self.scroll).p_4().flex().flex_col().gap_3()
                .child(div().flex().flex_shrink_0().flex_wrap().items_center().gap_3().child(div().text_size(px(24.)).child("Controller")).child(div().text_size(px(12.)).text_color(self.theme.muted()).child("PlayStation layout · live input & mappings")))
                .child(div().flex_shrink_0().text_size(px(12.)).text_color(self.theme.muted()).child(device_label)).when(self.devices.len()>1, |d| d.child(devices)).child(surfaces)
                .child(div().flex().flex_shrink_0().gap_4().when(!wide,|d|d.flex_col()).child(div().flex_1().min_w_0().flex().flex_col().gap_3().child(map).child(controls)
                    .child(div().text_size(px(11.)).text_color(self.theme.muted()).child("Arrows / Tab: select · Enter / [ ]: action · 1–4: surface · ⌘S: apply · C: capture · T: test · D: discard · R: reload · Backspace: defaults · Page Up/Down: scroll · Home: top · Esc: back"))
                    .child(div().text_size(px(11.)).text_color(self.theme.muted()).child(self.device.and_then(|id|self.devices.get(&id)).map(|d|format!("Left stick: {} · Right stick: {} · Trigger travel: unavailable",if d.axes[0]&&d.axes[1]{format!("{:+.2}, {:+.2}",d.sticks[0],d.sticks[1])}else{"unavailable".into()},if d.axes[2]&&d.axes[3]{format!("{:+.2}, {:+.2}",d.sticks[2],d.sticks[3])}else{"unavailable".into()})).unwrap_or_else(||"Stick movement will appear when a controller is connected. Trigger travel is not collected.".into())))).child(inspector))
                .when_some(self.render_error.clone(),|d,e|d.child(div().text_size(px(12.)).child(format!("Graphics unavailable: {e}")))))
            .child(div().flex_shrink_0().p_3().border_t_1().border_color(self.theme.raised()).flex().flex_col().gap_2()
                .child(div().text_size(px(12.)).child(format!("{}{}",if dirty{"Unsaved draft · "}else{""},self.message)))
                .child(div().flex().flex_wrap().gap_2()
                    .child(button("apply-controller","Apply",dirty).on_click(cx.listener(|this,_,_,cx|this.apply(cx))))
                    .child(button("discard-controller","Discard",false).on_click(cx.listener(|this,_,_,cx|{this.draft=this.saved.clone();this.cancel_capture();this.message="Draft discarded.".into();cx.notify();})))
                    .child(button("reset-controller","Reset this surface",false).on_click(cx.listener(|this,_,_,cx|{this.draft.bindings.remove(&this.surface);this.message="Defaults restored in draft. Apply to save.".into();cx.notify();})))
                    .child(button("reload-controller","Reload saved",false).on_click(cx.listener(|this,_,_,cx|this.reload(cx))))))
    }
}
