//! Per-connection device state. Axes replace snapshots; discrete edges stay ordered.
use super::{map_button, PadEvent, Stick};
use gilrs::{Axis, Button, EventType, Gilrs};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: u64,
    pub name: String,
    pub mapping: String,
    pub supported: u32,
    pub axes: [bool; 4],
    pub held: u32,
    pub sticks: [f32; 4],
}
impl Device {
    pub fn neutral(&self) -> bool {
        self.held == 0
            && self
                .sticks
                .chunks_exact(2)
                .all(|v| v[0] * v[0] + v[1] * v[1] < super::DEAD_ZONE_EXIT * super::DEAD_ZONE_EXIT)
    }
}
#[derive(Default)]
struct Pending {
    devices: BTreeMap<u64, Device>,
    events: VecDeque<(u64, PadEvent)>,
    error: Option<String>,
    reset: bool,
    shutdown: bool,
}
impl Pending {
    fn push(&mut self, id: u64, event: PadEvent) {
        if self.events.len() >= 256 {
            // Never execute a partial edge history after UI starvation. Consumers
            // clear actions and wait for physical neutral before accepting input.
            self.events.clear();
            self.reset = true;
        }
        self.events.push_back((id, event));
    }
}
pub struct Update {
    pub devices: BTreeMap<u64, Device>,
    pub events: Vec<(u64, PadEvent)>,
    pub error: Option<String>,
    pub reset: bool,
}
pub struct Hub {
    shared: Arc<Mutex<Pending>>,
}
impl Hub {
    pub fn spawn() -> std::io::Result<(Self, futures::channel::mpsc::Receiver<()>)> {
        let shared = Arc::new(Mutex::new(Pending::default()));
        let copy = shared.clone();
        let (mut tx, rx) = futures::channel::mpsc::channel(1);
        std::thread::Builder::new()
            .name("tbias-gamepad".into())
            .spawn(move || {
                let mut gilrs = match Gilrs::new() {
                    Ok(g) => g,
                    Err(e) => {
                        copy.lock().unwrap().error =
                            Some(format!("Controller subsystem unavailable: {e}"));
                        let _ = tx.try_send(());
                        return;
                    }
                };
                let mut connections = BTreeMap::<usize, u64>::new();
                let mut serial = 0u64;
                let mut tick = std::time::Instant::now();
                loop {
                    if copy.lock().unwrap().shutdown {
                        break;
                    }
                    let mut changed = false;
                    if tick.elapsed() > Duration::from_millis(500) {
                        copy.lock().unwrap().reset = true;
                        changed = true;
                    }
                    tick = std::time::Instant::now();
                    // Announce existing controllers and assign a fresh identity on reconnect.
                    for (id, pad) in gilrs.gamepads() {
                        let raw = usize::from(id);
                        if !pad.is_connected() || connections.contains_key(&raw) {
                            continue;
                        }
                        serial += 1;
                        connections.insert(raw, serial);
                        let supported = BUTTONS.iter().enumerate().fold(0, |mask, (i, b)| {
                            mask | if pad.button_code(*b).is_some() {
                                1 << i
                            } else {
                                0
                            }
                        });
                        let device = Device {
                            id: serial,
                            name: pad.name().into(),
                            mapping: format!("{:?}", pad.mapping_source()),
                            supported,
                            axes: AXES.map(|a| pad.axis_code(a).is_some()),
                            held: 0,
                            sticks: [0.; 4],
                        };
                        let mut p = copy.lock().unwrap();
                        p.push(serial, PadEvent::Connected(device.name.clone()));
                        p.devices.insert(serial, device);
                        changed = true;
                    }
                    while let Some(event) = gilrs.next_event() {
                        let raw = usize::from(event.id);
                        let Some(&id) = connections.get(&raw) else {
                            continue;
                        };
                        let mut p = copy.lock().unwrap();
                        match event.event {
                            EventType::ButtonPressed(button, _) => {
                                if let Some(b) = map_button(button) {
                                    p.push(id, PadEvent::Pressed(b));
                                    changed = true;
                                }
                            }
                            EventType::ButtonReleased(button, _) => {
                                if let Some(b) = map_button(button) {
                                    p.push(id, PadEvent::Released(b));
                                    changed = true;
                                }
                            }
                            EventType::Disconnected => {
                                if let Some(d) = p.devices.remove(&id) {
                                    p.push(id, PadEvent::Disconnected(d.name));
                                }
                                connections.remove(&raw);
                                changed = true;
                            }
                            _ => {}
                        }
                    }
                    for (raw_id, pad) in gilrs.gamepads() {
                        let Some(id) = connections.get(&usize::from(raw_id)) else {
                            continue;
                        };
                        let mut p = copy.lock().unwrap();
                        let Some(d) = p.devices.get_mut(id) else {
                            continue;
                        };
                        let held = BUTTONS.iter().enumerate().fold(0, |m, (i, b)| {
                            m | if pad.is_pressed(*b) { 1 << i } else { 0 }
                        });
                        let sticks = AXES.map(|a| {
                            let v = pad.value(a);
                            if v.is_finite() {
                                v.clamp(-1., 1.)
                            } else {
                                0.
                            }
                        });
                        changed |= d.held != held
                            || d.sticks != sticks
                            || sticks.chunks_exact(2).any(|v| {
                                v[0] * v[0] + v[1] * v[1]
                                    >= super::DEAD_ZONE_EXIT * super::DEAD_ZONE_EXIT
                            });
                        d.held = held;
                        d.sticks = sticks;
                    }
                    if changed && tx.try_send(()).is_err_and(|e| e.is_disconnected()) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(8));
                }
            })?;
        Ok((Self { shared }, rx))
    }
    pub fn take(&self) -> Update {
        let mut p = self.shared.lock().unwrap();
        Update {
            devices: p.devices.clone(),
            events: p.events.drain(..).collect(),
            error: p.error.clone(),
            reset: std::mem::take(&mut p.reset),
        }
    }
}
impl Drop for Hub {
    fn drop(&mut self) {
        self.shared.lock().unwrap().shutdown = true;
    }
}
const AXES: [Axis; 4] = [
    Axis::LeftStickX,
    Axis::LeftStickY,
    Axis::RightStickX,
    Axis::RightStickY,
];
const BUTTONS: [Button; 16] = [
    Button::North,
    Button::East,
    Button::South,
    Button::West,
    Button::DPadUp,
    Button::DPadDown,
    Button::DPadLeft,
    Button::DPadRight,
    Button::LeftTrigger,
    Button::RightTrigger,
    Button::LeftTrigger2,
    Button::RightTrigger2,
    Button::LeftThumb,
    Button::RightThumb,
    Button::Start,
    Button::Select,
];
pub fn stick_events(d: &Device) -> [PadEvent; 2] {
    std::array::from_fn(|i| {
        let x = d.sticks[i * 2];
        let y = d.sticks[i * 2 + 1];
        let active = x * x + y * y >= super::DEAD_ZONE_EXIT * super::DEAD_ZONE_EXIT;
        PadEvent::Stick {
            stick: if i == 0 { Stick::Left } else { Stick::Right },
            x: if active { x } else { 0. },
            y: if active { y } else { 0. },
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::gamepad::PsButton;
    #[test]
    fn diagonal_deflection_requires_neutral_and_releases_both_axes() {
        let mut d = device(1);
        d.sticks = [0.3, 0.3, 0., 0.];
        assert!(!d.neutral());
        assert_eq!(
            stick_events(&d)[0],
            PadEvent::Stick {
                stick: Stick::Left,
                x: 0.3,
                y: 0.3
            }
        );
        d.sticks = [0.; 4];
        assert!(d.neutral());
        assert_eq!(
            stick_events(&d)[0],
            PadEvent::Stick {
                stick: Stick::Left,
                x: 0.,
                y: 0.
            }
        );
    }
    fn device(id: u64) -> Device {
        Device {
            id,
            name: id.to_string(),
            mapping: "test".into(),
            supported: 0xffff,
            axes: [true; 4],
            held: 0,
            sticks: [0.; 4],
        }
    }
    #[test]
    fn two_devices_have_independent_state_and_reconnect_identity() {
        let mut p = Pending::default();
        p.devices.insert(1, device(1));
        p.devices.insert(2, device(2));
        p.devices.get_mut(&1).unwrap().held = 1;
        p.devices.get_mut(&1).unwrap().sticks[0] = 1.;
        assert!(p.devices[&2].neutral());
        assert!(!p.devices[&1].neutral());
        p.devices.remove(&1);
        p.devices.insert(3, device(3));
        assert!(p.devices[&3].neutral());
    }
    #[test]
    fn edge_overflow_requests_neutral_reset() {
        let mut p = Pending::default();
        for _ in 0..300 {
            p.push(1, PadEvent::Pressed(PsButton::Cross));
        }
        assert!(p.reset);
        assert!(p.events.len() <= 256);
    }
}
