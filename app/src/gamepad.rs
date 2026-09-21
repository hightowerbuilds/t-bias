// t-bias — PlayStation controller input (PS2 roadmap, Phases 0-1).
//
// A dedicated thread owns `Gilrs` and forwards controller activity to the GPUI
// thread over an unbounded channel — the same shape as `pty_reader_loop` in
// `terminal.rs`, for the same reason: the blocking/polling work must not touch
// the render thread.
//
// `Gilrs` is `!Send` on macOS (it holds CoreFoundation types and pumps a
// CFRunLoop inside `next_event`), so it is **created inside the poll thread and
// never moved**. That constraint is why `spawn` returns only a receiver.
//
// Everything below the thread boundary is a pure model — no gilrs types escape
// this module. `input.rs` set that precedent: fiddly input mappings are pinned
// by unit tests rather than eyeballed in a running app.

// The HUD, modal system, and text entry consume the stick/sector API in later
// phases; the Phase 0 wiring only needs buttons. Allow dead code until then,
// matching the convention in `pane_tree.rs` / `workspace.rs` / `db.rs`.
#![allow(dead_code)]

use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, FRAC_PI_8, TAU};
use std::thread;
use std::time::Duration;

use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use gilrs::{Axis, Button, EventType, Gilrs};

use crate::input::KeyMods;

/// Poll interval. 125 Hz keeps button latency under 8 ms (a gamepad user feels
/// anything past ~16 ms) and gives analog scrolling a smooth repeat rate.
const TICK: Duration = Duration::from_millis(8);

/// Stick deflection needed to *enter* a sector, and the lower value it must fall
/// back below to *leave* one. The gap is deliberate hysteresis — a thumb resting
/// near the threshold would otherwise chatter in and out of the dead zone.
pub const DEAD_ZONE_ENTER: f32 = 0.5;
pub const DEAD_ZONE_EXIT: f32 = 0.35;

/// Extra angular margin (as a fraction of a half-sector) a stick must cross
/// before switching sectors, so a wobble near a boundary doesn't flicker.
const SECTOR_MARGIN: f32 = 0.3;

/// The abstract PlayStation button layout. Deliberately *not* gilrs's naming:
/// a DualShock 2 behind a USB adapter and a DualShock 4 over Bluetooth differ
/// only in how they map onto this enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PsButton {
    Triangle,
    Circle,
    Cross,
    Square,
    Up,
    Down,
    Left,
    Right,
    L1,
    R1,
    L2,
    R2,
    L3,
    R3,
    Start,
    Select,
}

/// Which analog stick a reading came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stick {
    Left,
    Right,
}

/// Controller activity, as seen by the UI thread.
#[derive(Clone, Debug, PartialEq)]
pub enum PadEvent {
    Connected(String),
    Disconnected(String),
    Pressed(PsButton),
    Released(PsButton),
    /// Current stick deflection. Emitted on change *and* repeated every tick
    /// while the stick is held off-center, so held-stick scrolling keeps moving
    /// (an unchanging axis produces no gilrs events at all).
    Stick {
        stick: Stick,
        x: f32,
        y: f32,
    },
}

/// What a button does, expressed in terms `input::encode_key` already
/// understands — the CSI / DECCKM / control-code logic there is tested, and
/// reimplementing it for the pad would mean maintaining two copies.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PadAction {
    /// Send a keystroke through the existing key encoder.
    Key { key: &'static str, mods: KeyMods },
    /// Scroll the viewport by a number of lines (negative = up/back).
    Scroll(i32),
}

const NO_MODS: KeyMods = KeyMods {
    ctrl: false,
    alt: false,
    shift: false,
    cmd: false,
};

const CTRL: KeyMods = KeyMods {
    ctrl: true,
    alt: false,
    shift: false,
    cmd: false,
};

/// The default Navigate-mode binding: a terminal you can *operate* by pad, even
/// before you can type into it. Most terminal work is re-running and navigating,
/// not composing prose — so these verbs carry most of the day-to-day value.
pub fn binding(button: PsButton) -> Option<PadAction> {
    use PsButton::*;
    let key = |key| Some(PadAction::Key { key, mods: NO_MODS });
    match button {
        // Face buttons: submit, interrupt, complete.
        Triangle => key("enter"),
        Circle => Some(PadAction::Key {
            key: "c",
            mods: CTRL,
        }),
        Square => key("tab"),
        Cross => key("space"),
        // D-pad drives the arrow keys through the tested encoder, so
        // application-cursor mode keeps working inside vim/less.
        Up => key("up"),
        Down => key("down"),
        Left => key("left"),
        Right => key("right"),
        // Shoulders: shell history (Up/Down at the prompt) and paging.
        L1 => key("up"),
        R1 => key("down"),
        L2 => Some(PadAction::Scroll(-10)),
        R2 => Some(PadAction::Scroll(10)),
        // Reserved for the modal system and palette (Phases 4-5).
        L3 | R3 | Start | Select => None,
    }
}

/// Start the controller thread. Returns the receiver to drain on the UI side;
/// `None` if no gamepad subsystem could be opened at all (the app stays fully
/// usable by keyboard — the pad is always an *additional* input source).
pub fn spawn() -> Option<UnboundedReceiver<PadEvent>> {
    let (tx, rx) = unbounded::<PadEvent>();
    match thread::Builder::new()
        .name("tbias-gamepad".into())
        .spawn(move || poll_loop(tx))
    {
        Ok(_) => Some(rx),
        Err(err) => {
            log::error!("failed to spawn gamepad thread: {err}");
            None
        }
    }
}

/// Owns `Gilrs` for the life of the thread, translating its events into
/// `PadEvent`s. Exits (silently, leaving the keyboard working) if the gamepad
/// subsystem is unavailable.
fn poll_loop(tx: UnboundedSender<PadEvent>) {
    let mut gilrs = match Gilrs::new() {
        Ok(g) => g,
        Err(err) => {
            log::error!("gamepad subsystem unavailable: {err}");
            return;
        }
    };

    // Announce controllers already paired and awake at startup — gilrs only
    // emits `Connected` for devices that arrive *after* initialization.
    for (_id, gamepad) in gilrs.gamepads() {
        if tx
            .unbounded_send(PadEvent::Connected(gamepad.name().to_string()))
            .is_err()
        {
            return;
        }
    }

    let mut left = StickState::default();
    let mut right = StickState::default();

    loop {
        while let Some(event) = gilrs.next_event() {
            let send = match event.event {
                EventType::ButtonPressed(button, _) => map_button(button).map(PadEvent::Pressed),
                EventType::ButtonReleased(button, _) => map_button(button).map(PadEvent::Released),
                EventType::AxisChanged(axis, value, _) => {
                    match axis {
                        Axis::LeftStickX => left.x = value,
                        Axis::LeftStickY => left.y = value,
                        Axis::RightStickX => right.x = value,
                        Axis::RightStickY => right.y = value,
                        _ => {}
                    }
                    None // the per-tick emit below covers sticks
                }
                EventType::Connected => Some(PadEvent::Connected(
                    gilrs.gamepad(event.id).name().to_string(),
                )),
                EventType::Disconnected => {
                    // A DualShock 4 sleeps aggressively; recover the neutral
                    // position so a stale deflection can't scroll forever.
                    left = StickState::default();
                    right = StickState::default();
                    Some(PadEvent::Disconnected(
                        gilrs.gamepad(event.id).name().to_string(),
                    ))
                }
                _ => None,
            };
            if let Some(event) = send {
                if tx.unbounded_send(event).is_err() {
                    return; // UI is gone
                }
            }
        }

        // Repeat deflected sticks every tick so held-stick scrolling continues.
        for (stick, state) in [(Stick::Left, left), (Stick::Right, right)] {
            if state.magnitude() >= DEAD_ZONE_EXIT {
                let event = PadEvent::Stick {
                    stick,
                    x: state.x,
                    y: state.y,
                };
                if tx.unbounded_send(event).is_err() {
                    return;
                }
            }
        }

        thread::sleep(TICK);
    }
}

#[derive(Clone, Copy, Default)]
struct StickState {
    x: f32,
    y: f32,
}

impl StickState {
    fn magnitude(&self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

/// gilrs's abstract button names onto the PlayStation layout. gilrs calls the
/// bumpers `*Trigger` and the triggers `*Trigger2`, which is worth stating
/// plainly because getting it backwards is silent and confusing.
fn map_button(button: Button) -> Option<PsButton> {
    Some(match button {
        Button::North => PsButton::Triangle,
        Button::East => PsButton::Circle,
        Button::South => PsButton::Cross,
        Button::West => PsButton::Square,
        Button::DPadUp => PsButton::Up,
        Button::DPadDown => PsButton::Down,
        Button::DPadLeft => PsButton::Left,
        Button::DPadRight => PsButton::Right,
        Button::LeftTrigger => PsButton::L1,
        Button::LeftTrigger2 => PsButton::L2,
        Button::RightTrigger => PsButton::R1,
        Button::RightTrigger2 => PsButton::R2,
        Button::LeftThumb => PsButton::L3,
        Button::RightThumb => PsButton::R3,
        Button::Start => PsButton::Start,
        Button::Select => PsButton::Select,
        _ => return None,
    })
}

/// Quantize a stick vector to one of 8 compass sectors, numbered clockwise from
/// north (0 = up, 1 = up-right, 2 = right, …). Returns `None` inside the dead
/// zone.
///
/// `current` is the sector the stick was in on the previous reading; passing it
/// engages hysteresis on both the dead zone and the sector boundaries, so a
/// resting thumb neither chatters into the dead zone nor flickers between two
/// neighbouring sectors. This is the geometry the radial keyboard (Phase 3) is
/// built on, so it is tested directly rather than tuned by feel in the app.
pub fn sector(x: f32, y: f32, current: Option<u8>) -> Option<u8> {
    let magnitude = (x * x + y * y).sqrt();
    let threshold = if current.is_some() {
        DEAD_ZONE_EXIT
    } else {
        DEAD_ZONE_ENTER
    };
    if magnitude < threshold {
        return None;
    }

    // atan2 measures counter-clockwise from east; sectors run clockwise from
    // north, so rotate and flip into that frame before quantizing.
    let angle = (FRAC_PI_2 - y.atan2(x)).rem_euclid(TAU);
    let raw = ((angle / FRAC_PI_4).round() as usize % 8) as u8;

    match current {
        // Already in a sector: only leave it once clearly past the boundary.
        Some(cur) if raw != cur => {
            let center = cur as f32 * FRAC_PI_4;
            if angular_distance(angle, center) > FRAC_PI_8 * (1.0 + SECTOR_MARGIN) {
                Some(raw)
            } else {
                Some(cur)
            }
        }
        _ => Some(raw),
    }
}

/// Shortest angular distance between two angles, in radians.
fn angular_distance(a: f32, b: f32) -> f32 {
    let diff = (a - b).abs().rem_euclid(TAU);
    diff.min(TAU - diff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dead_zone_rejects_a_resting_stick() {
        assert_eq!(sector(0.0, 0.0, None), None);
        assert_eq!(sector(0.2, 0.1, None), None);
        // Just under the enter threshold from neutral.
        assert_eq!(sector(0.0, 0.45, None), None);
    }

    #[test]
    fn sectors_run_clockwise_from_north() {
        // Cardinals: north is 0, then clockwise.
        assert_eq!(sector(0.0, 1.0, None), Some(0)); // up
        assert_eq!(sector(1.0, 0.0, None), Some(2)); // right
        assert_eq!(sector(0.0, -1.0, None), Some(4)); // down
        assert_eq!(sector(-1.0, 0.0, None), Some(6)); // left
                                                      // Diagonals land on the odd sectors.
        assert_eq!(sector(0.7, 0.7, None), Some(1)); // up-right
        assert_eq!(sector(0.7, -0.7, None), Some(3)); // down-right
        assert_eq!(sector(-0.7, -0.7, None), Some(5)); // down-left
        assert_eq!(sector(-0.7, 0.7, None), Some(7)); // up-left
    }

    #[test]
    fn hysteresis_holds_a_sector_near_its_boundary() {
        // Sitting just past the 0/1 boundary (22.5°) while already in sector 0
        // must not flip — the margin has to be crossed first.
        let near_boundary = (0.40_f32, 0.92_f32); // ~23.5° east of north
        assert_eq!(sector(near_boundary.0, near_boundary.1, None), Some(1));
        assert_eq!(sector(near_boundary.0, near_boundary.1, Some(0)), Some(0));
        // Pushed well into sector 1, it switches.
        assert_eq!(sector(0.7, 0.7, Some(0)), Some(1));
    }

    #[test]
    fn dead_zone_hysteresis_keeps_a_held_sector_alive() {
        // Between the exit and enter thresholds: too weak to start a new
        // sector, strong enough to hold the one already engaged.
        let (x, y) = (0.0_f32, 0.42_f32);
        assert_eq!(sector(x, y, None), None);
        assert_eq!(sector(x, y, Some(0)), Some(0));
        // Below the exit threshold it releases regardless.
        assert_eq!(sector(0.0, 0.3, Some(0)), None);
    }

    #[test]
    fn playstation_layout_maps_off_gilrs_names() {
        // The bumper/trigger naming is the easy one to get backwards.
        assert_eq!(map_button(Button::LeftTrigger), Some(PsButton::L1));
        assert_eq!(map_button(Button::LeftTrigger2), Some(PsButton::L2));
        assert_eq!(map_button(Button::RightTrigger), Some(PsButton::R1));
        assert_eq!(map_button(Button::RightTrigger2), Some(PsButton::R2));
        // Face buttons follow the PlayStation diamond, not Xbox lettering.
        assert_eq!(map_button(Button::North), Some(PsButton::Triangle));
        assert_eq!(map_button(Button::South), Some(PsButton::Cross));
        assert_eq!(map_button(Button::Unknown), None);
    }

    #[test]
    fn verbs_reuse_the_key_encoder() {
        use crate::input::encode_key;
        // ○ interrupts: the binding names a key + modifier, and the existing
        // encoder turns that into the real control byte.
        let Some(PadAction::Key { key, mods }) = binding(PsButton::Circle) else {
            panic!("circle should be bound");
        };
        assert_eq!(encode_key(key, None, mods, false), Some(vec![0x03]));

        // D-pad up must honour application-cursor mode, which it gets for free
        // by going through the encoder rather than hardcoding bytes.
        let Some(PadAction::Key { key, mods }) = binding(PsButton::Up) else {
            panic!("d-pad up should be bound");
        };
        assert_eq!(encode_key(key, None, mods, false), Some(b"\x1b[A".to_vec()));
        assert_eq!(encode_key(key, None, mods, true), Some(b"\x1bOA".to_vec()));
    }
}
