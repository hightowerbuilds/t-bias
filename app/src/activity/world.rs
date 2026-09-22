//! Small educational scene: real 3D coordinates projected into native GPUI paths.
//! Geometry is a teaching map, not hardware discovery or a guest computer emulator.
use super::model::{self, SystemSample};
use crate::gamepad::{PadEvent, PsButton, Stick};
use gpui::{
    div, prelude::*, px, rgb, Context, EventEmitter, FocusHandle, KeyDownEvent, KeyUpEvent,
    Subscription, Window,
};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}
impl Vec3 {
    fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
    fn dot(self, b: Self) -> f32 {
        self.x * b.x + self.y * b.y + self.z * b.z
    }
    fn sub(self, b: Self) -> Self {
        Self::new(self.x - b.x, self.y - b.y, self.z - b.z)
    }
}
#[derive(Clone, Debug)]
struct Camera {
    position: Vec3,
    yaw: f32,
    pitch: f32,
}
impl Default for Camera {
    fn default() -> Self {
        Self {
            position: Vec3::new(0., 12., 19.),
            yaw: 0.,
            pitch: -0.7,
        }
    }
}
impl Camera {
    fn transform(&self, p: Vec3) -> Vec3 {
        let d = p.sub(self.position);
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(
            d.dot(Vec3::new(cy, 0., sy)),
            d.dot(Vec3::new(-sy * sp, cp, cy * sp)),
            d.dot(Vec3::new(sy * cp, sp, -cy * cp)),
        )
    }
    fn step(&mut self, movement: [f32; 3], look: [f32; 2], dt: f32) {
        let dt = dt.clamp(0., 0.05);
        self.yaw = (self.yaw + look[0] * dt * 1.5).rem_euclid(std::f32::consts::TAU);
        self.pitch = (self.pitch + look[1] * dt * 1.2).clamp(-1.4, 1.2);
        let (s, c) = self.yaw.sin_cos();
        let length =
            (movement[0] * movement[0] + movement[1] * movement[1] + movement[2] * movement[2])
                .sqrt()
                .max(1.);
        let distance = dt * 7. / length;
        self.position.x =
            (self.position.x + (movement[0] * c + movement[1] * s) * distance).clamp(-30., 30.);
        self.position.z =
            (self.position.z + (movement[0] * s - movement[1] * c) * distance).clamp(-30., 30.);
        self.position.y = (self.position.y + movement[2] * distance).clamp(1.5, 28.);
    }
}
fn near_clip(poly: &[Vec3]) -> Vec<Vec3> {
    let mut out = vec![];
    if poly.is_empty() {
        return out;
    }
    let mut a = *poly.last().unwrap();
    for &b in poly {
        let ai = a.z >= 0.3;
        let bi = b.z >= 0.3;
        if ai != bi {
            let t = (0.3 - a.z) / (b.z - a.z);
            out.push(Vec3::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 0.3));
        }
        if bi {
            out.push(b);
        }
        a = b;
    }
    out
}
#[derive(Default)]
struct Controls {
    keys: HashSet<String>,
    left: [f32; 2],
    right: [f32; 2],
    rise: bool,
    fall: bool,
    armed: bool,
}
impl Controls {
    fn clear(&mut self) {
        self.keys.clear();
        self.left = [0.; 2];
        self.right = [0.; 2];
        self.rise = false;
        self.fall = false;
        self.armed = false;
    }
    fn vectors(&self) -> ([f32; 3], [f32; 2]) {
        let key = |s: &str| if self.keys.contains(s) { 1. } else { 0. };
        let (left, right) = if self.armed {
            (self.left, self.right)
        } else {
            ([0.; 2], [0.; 2])
        };
        (
            [
                key("d") - key("a") + left[0],
                key("w") - key("s") + left[1],
                key("e") - key("q") + u8::from(self.rise) as f32 - u8::from(self.fall) as f32,
            ],
            [
                key("right") - key("left") + right[0],
                key("up") - key("down") + right[1],
            ],
        )
    }
    fn moving(&self) -> bool {
        let (m, l) = self.vectors();
        m.into_iter().chain(l).any(|v| v.abs() > 0.01)
    }
}
pub enum WorldEvent {
    Back,
    Learn(usize),
}
pub struct ComputerWorld {
    camera: Camera,
    controls: Controls,
    visible: bool,
    active: bool,
    ticking: bool,
    focus: FocusHandle,
    focus_requested: bool,
    activation: Option<Subscription>,
    system: SystemSample,
    sample_age: Option<u64>,
    live: bool,
    station: usize,
    flat: bool,
}
impl EventEmitter<WorldEvent> for ComputerWorld {}
impl ComputerWorld {
    pub fn smoke_camera(&self) -> ([f32; 3], bool) {
        (
            [
                self.camera.position.x,
                self.camera.position.y,
                self.camera.position.z,
            ],
            self.controls.moving(),
        )
    }
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            camera: Camera::default(),
            controls: Controls {
                armed: true,
                ..Default::default()
            },
            visible: false,
            active: true,
            ticking: false,
            focus: cx.focus_handle(),
            focus_requested: false,
            activation: None,
            system: SystemSample::default(),
            sample_age: None,
            live: false,
            station: 0,
            flat: false,
        }
    }
    pub fn visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        self.visible = visible;
        self.focus_requested = visible;
        let neutral = self.controls.left == [0.; 2] && self.controls.right == [0.; 2];
        self.controls.clear();
        self.controls.armed = neutral;
        cx.notify();
    }
    pub fn sample(
        &mut self,
        system: SystemSample,
        age: Option<u64>,
        live: bool,
        cx: &mut Context<Self>,
    ) {
        self.system = system;
        self.sample_age = age;
        self.live = live;
        cx.notify();
    }
    fn start_tick(&mut self, cx: &mut Context<Self>) {
        if self.ticking || !self.visible || !self.active || self.flat || !self.controls.moving() {
            return;
        }
        self.ticking = true;
        cx.spawn(async move |this, cx| {
            let mut last = Instant::now();
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(33))
                    .await;
                let now = Instant::now();
                let dt = now.duration_since(last).as_secs_f32();
                last = now;
                let keep = this
                    .update(cx, |this, cx| {
                        if !this.visible || !this.active || this.flat || !this.controls.moving() {
                            this.ticking = false;
                            return false;
                        }
                        let (m, l) = this.controls.vectors();
                        this.camera.step(m, l, dt);
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }
    pub fn on_pad(&mut self, event: PadEvent, cx: &mut Context<Self>) {
        match event {
            PadEvent::Disconnected(_) => self.controls.clear(),
            PadEvent::Stick { stick, x, y } => {
                let neutral = x * x + y * y < 0.35 * 0.35;
                let v = if neutral {
                    [0.; 2]
                } else {
                    [x.clamp(-1., 1.), y.clamp(-1., 1.)]
                };
                match stick {
                    Stick::Left => self.controls.left = v,
                    Stick::Right => self.controls.right = v,
                }
                if self.controls.left == [0.; 2] && self.controls.right == [0.; 2] {
                    self.controls.armed = true;
                }
            }
            PadEvent::Pressed(button) if self.visible && self.active => match button {
                PsButton::Circle => {
                    self.controls.clear();
                    cx.emit(WorldEvent::Back);
                }
                PsButton::Triangle => {
                    self.camera = Camera::default();
                    self.controls.clear();
                }
                PsButton::L1 => self.controls.fall = true,
                PsButton::R1 => self.controls.rise = true,
                PsButton::Left => self.jump((self.station + 3) % 4),
                PsButton::Right => self.jump((self.station + 1) % 4),
                PsButton::Cross if self.station < 2 => {
                    cx.emit(WorldEvent::Learn(if self.station == 1 { 2 } else { 1 }))
                }
                _ => {}
            },
            PadEvent::Released(PsButton::L1) => self.controls.fall = false,
            PadEvent::Released(PsButton::R1) => self.controls.rise = false,
            _ => {}
        }
        if self.visible && self.active {
            self.start_tick(cx);
            cx.notify();
        }
    }
    fn jump(&mut self, station: usize) {
        self.station = station;
        let target = station_position(station);
        self.camera = Camera {
            position: Vec3::new(target.x, target.y + 6., target.z + 10.),
            yaw: 0.,
            pitch: -0.55,
        };
        self.controls.clear();
    }
    fn key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let k = &event.keystroke;
        if k.modifiers.platform || k.modifiers.control || k.modifiers.alt {
            return;
        }
        match k.key.as_str() {
            "escape" => {
                self.controls.clear();
                cx.emit(WorldEvent::Back);
            }
            "r" => {
                self.camera = Camera::default();
                self.controls.clear();
            }
            "w" | "a" | "s" | "d" | "q" | "e" | "up" | "down" | "left" | "right" => {
                self.controls.keys.insert(k.key.clone());
                self.start_tick(cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}
fn station_position(i: usize) -> Vec3 {
    match i {
        0 => Vec3::new(-4., 1., -2.),
        1 => Vec3::new(4., 1., -2.),
        2 => Vec3::new(-4., 1., 6.),
        _ => Vec3::new(4., 1., 6.),
    }
}
fn button(id: &'static str, label: &'static str) -> gpui_kit::component::button::Button {
    crate::ui::button(id, label)
}
impl Render for ComputerWorld {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.activation.is_none() {
            self.active = window.is_window_active();
            self.activation = Some(cx.observe_window_activation(window, |this, w, _| {
                this.active = w.is_window_active();
                if !this.active {
                    this.controls.clear();
                }
            }));
        }
        if self.focus_requested {
            window.focus(&self.focus, cx);
            self.focus_requested = false;
        }
        let camera = self.camera.clone();
        let cpu = self.system.cpu;
        let scene = gpui::canvas(
            |bounds, _, _| bounds,
            move |bounds, _, window, cx| {
                let mut meshes = vec![(
                    Vec3::new(0., -0.3, 2.),
                    Vec3::new(18., 0.5, 16.),
                    0x153d37u32,
                )];
                for (i, color) in [(0, 0x447dd0), (1, 0x52ad87), (2, 0xd9a24c), (3, 0xa57acc)] {
                    let pos = station_position(i);
                    let size = match i {
                        0 => Vec3::new(4., 1.5, 4.),
                        1 => Vec3::new(4., 1., 4.),
                        _ => Vec3::new(4., 1.2, 3.),
                    };
                    meshes.push((pos, size, color));
                }
                // Simple component details are illustrative, not discovered hardware.
                meshes.push((
                    Vec3::new(-4., 1.9, -2.),
                    Vec3::new(3.4, 0.25, 3.4),
                    0xa7b5c8,
                ));
                for x in [3., 4., 5.] {
                    meshes.push((Vec3::new(x, 1.9, -2.), Vec3::new(0.3, 1.2, 3.2), 0x246744));
                }
                meshes.push((Vec3::new(-4., 1.7, 6.), Vec3::new(3.1, 0.15, 2.), 0xb9b8ad));
                for x in [3.3, 4.5] {
                    meshes.push((Vec3::new(x, 1., 7.55), Vec3::new(0.75, 0.6, 0.15), 0x263342));
                }
                // Single machine-level CPU indicator, not invented per-core readings.
                if let Some(cpu) = cpu {
                    meshes.push((
                        Vec3::new(-4., 2.15, -2.),
                        Vec3::new(
                            (cpu.clamp(0., 100.) as f32 / 100. * 3.6).max(0.03),
                            0.15,
                            0.6,
                        ),
                        0xa7d8ff,
                    ));
                }
                let mut faces = vec![];
                for (mesh_index, (center, size, color)) in meshes.into_iter().enumerate() {
                    let verts: Vec<_> = [
                        [-1., -1., -1.],
                        [1., -1., -1.],
                        [1., 1., -1.],
                        [-1., 1., -1.],
                        [-1., -1., 1.],
                        [1., -1., 1.],
                        [1., 1., 1.],
                        [-1., 1., 1.],
                    ]
                    .into_iter()
                    .map(|v| {
                        camera.transform(Vec3::new(
                            center.x + v[0] * size.x / 2.,
                            center.y + v[1] * size.y / 2.,
                            center.z + v[2] * size.z / 2.,
                        ))
                    })
                    .collect();
                    for (indices, shade) in [
                        ([0, 1, 2, 3], 0.65),
                        ([4, 5, 6, 7], 0.85),
                        ([0, 4, 7, 3], 0.75),
                        ([1, 5, 6, 2], 0.9),
                        ([3, 2, 6, 7], 1.),
                        ([0, 1, 5, 4], 0.5),
                    ] {
                        let poly = near_clip(&indices.map(|i| verts[i]));
                        if poly.len() < 3 {
                            continue;
                        }
                        let depth = poly.iter().map(|v| v.z).sum::<f32>() / poly.len() as f32;
                        faces.push((usize::from(mesh_index != 0), depth, poly, color, shade));
                    }
                }
                // Camera stays above the board; its large support plane must be painted first.
                faces.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)));
                let scale = f32::from(bounds.size.height) * 0.85;
                for (_, _, poly, color, shade) in faces {
                    let mut path = gpui::PathBuilder::fill();
                    for (i, p) in poly.iter().enumerate() {
                        let screen = gpui::point(
                            bounds.origin.x + bounds.size.width / 2. + px(p.x / p.z * scale),
                            bounds.origin.y + bounds.size.height / 2. - px(p.y / p.z * scale),
                        );
                        if i == 0 {
                            path.move_to(screen);
                        } else {
                            path.line_to(screen);
                        }
                    }
                    path.close();
                    if let Ok(path) = path.build() {
                        let mut color = rgb(color);
                        color.r *= shade;
                        color.g *= shade;
                        color.b *= shade;
                        window.paint_path(path, color);
                    }
                }
                for (i, label) in [(0, "CPU"), (1, "RAM"), (2, "Storage"), (3, "Network")] {
                    let mut position = station_position(i);
                    position.y = 3.5;
                    let p = camera.transform(position);
                    if p.z < 0.3 {
                        continue;
                    }
                    let text: gpui::SharedString = label.into();
                    let line = window.text_system().shape_line(
                        text.clone(),
                        px(14.),
                        &[gpui::TextRun {
                            len: text.len(),
                            font: gpui::font("Menlo"),
                            color: rgb(0xe9f0fa).into(),
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        }],
                        None,
                    );
                    let origin = gpui::point(
                        bounds.origin.x + bounds.size.width / 2. + px(p.x / p.z * scale)
                            - line.width / 2.,
                        bounds.origin.y + bounds.size.height / 2. - px(p.y / p.z * scale),
                    );
                    let _ = line.paint(origin, px(18.), gpui::TextAlign::Left, None, window, cx);
                }
            },
        )
        .size_full();
        let explanation=match self.station {
            0=>format!("CPU · {} machine utilization. A processor executes instructions over time; process CPU uses a different, per-core scale.",self.system.cpu.map(|v|format!("{v:.1}%")).unwrap_or_else(||"unavailable / warming up".into())),
            1=>format!("RAM · {} physical, {} wired. Process RSS can include shared pages; it does not identify an exclusive location on this model.",model::bytes(self.system.memory_total),model::bytes(self.system.memory_wired)),
            2=>"Storage · conceptual station. Files persist here in the teaching model. Disk throughput is not collected yet.".into(),
            _=>"Network · conceptual station. Programs exchange data and wait for replies. Network throughput is not collected yet.".into(),
        };
        let mut stations = div().flex().flex_wrap().gap_2();
        for (i, id, label) in [
            (0, "cpu-station", "CPU"),
            (1, "ram-station", "RAM"),
            (2, "disk-station", "Storage"),
            (3, "net-station", "Network"),
        ] {
            stations = stations.child(button(id, label).on_click(cx.listener(
                move |this, _, window, cx| {
                    this.jump(i);
                    window.focus(&this.focus, cx);
                    cx.notify();
                },
            )));
        }
        div().id("computer-world").track_focus(&self.focus).on_key_down(cx.listener(Self::key)).on_key_up(cx.listener(|this,e:&KeyUpEvent,_,_|{this.controls.keys.remove(&e.keystroke.key);})).size_full().flex().flex_col().min_h_0().bg(rgb(0x101b2b)).text_color(rgb(0xe9f0fa))
            .child(div().p_3().flex().flex_wrap().gap_2().child("Inside your computer · Educational model")
                .child(button("world-back","Back").on_click(cx.listener(|_,_,_,cx|cx.emit(WorldEvent::Back))))
                .child(button("world-reset","Reset view").on_click(cx.listener(|this,_,_,cx|{this.camera=Camera::default();this.controls.clear();cx.notify();})))
                .child(button("world-flat",if self.flat {"3D view"}else{"2D / no motion"}).on_click(cx.listener(|this,_,_,cx|{this.flat=!this.flat;this.controls.clear();cx.notify();}))))
            .child(div().px_3().pb_2().child(stations))
            .child(div().flex_1().min_h(px(80.)).overflow_hidden().when(!self.flat,|d|d.child(scene)).when(self.flat,|d|d.child(div().p_4().child("CPU executes instructions → RAM holds working data → Storage retains files → Network connects systems. Select a component above to explore its role."))))
            .child(div().p_3().child(explanation).child(format!("{} · sample {} · simplified layout, not your physical motherboard",if self.live {"Live Mac readings"}else{"Paused / unavailable readings"},self.sample_age.map(|s|format!("{s}s old")).unwrap_or_else(||"unavailable".into())))
                .when(self.station<2,|d|d.child(button("station-lesson","Read this lesson").on_click(cx.listener(|this,_,_,cx|cx.emit(WorldEvent::Learn(if this.station==0{1}else{2})))))))
            .child(div().px_3().pb_2().text_size(px(11.)).child("Left stick / WASD: move · Right stick / arrows: look · L1/R1 or Q/E: down/up · △ / R: reset · ○ / Esc: back · Center sticks after switching views."))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn camera_steps_are_bounded_and_projection_has_near_clip() {
        let mut c = Camera::default();
        for _ in 0..10000 {
            c.step([1., 1., 1.], [1., 1.], 1.);
        }
        assert!(c.position.x.abs() <= 30. && c.position.y <= 28. && c.pitch <= 1.2);
        let p = near_clip(&[
            Vec3::new(-1., 0., -1.),
            Vec3::new(1., 0., 1.),
            Vec3::new(0., 1., 1.),
        ]);
        assert_eq!(p.len(), 4);
        assert!(p.iter().all(|v| v.z >= 0.3));
    }
    #[test]
    fn clearing_input_stops_flight() {
        let mut c = Controls {
            armed: true,
            left: [1., 1.],
            rise: true,
            ..Default::default()
        };
        assert!(c.moving());
        c.clear();
        assert!(!c.moving());
        let cam = Camera::default();
        assert!(cam.transform(Vec3::new(0., 0., 0.)).z > 0.);
    }
}
