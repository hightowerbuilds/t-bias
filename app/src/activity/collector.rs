//! One sleeping worker, one replaceable snapshot, bounded wake notifications.
use super::model::{self, Identity, Process, Scope, ShellRoot, Sort, SystemSample};
use futures::channel::mpsc;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub visible: bool,
    pub active: bool,
    pub paused: bool,
    pub interval: u64,
    pub query: String,
    pub scope: Scope,
    pub sort: Sort,
    pub descending: bool,
    pub roots: Vec<ShellRoot>,
    pub active_pane: Option<(u64, u64)>,
    pub selected: Option<Identity>,
    pub tree: bool,
    pub expanded: HashSet<Identity>,
    pub columns: std::collections::BTreeSet<Sort>,
}
impl Default for Request {
    fn default() -> Self {
        Self {
            visible: false,
            active: true,
            paused: false,
            interval: 2,
            query: String::new(),
            scope: Scope::All,
            sort: Sort::Cpu,
            descending: true,
            roots: vec![],
            active_pane: None,
            selected: None,
            tree: false,
            expanded: HashSet::new(),
            columns: super::preferences::Preferences::default().columns,
        }
    }
}
impl Request {
    pub fn preferences(&self) -> super::preferences::Preferences {
        super::preferences::Preferences {
            scope: self.scope,
            sort: self.sort,
            descending: self.descending,
            tree: self.tree,
            columns: self.columns.clone(),
            ..Default::default()
        }
    }
    pub fn running(&self) -> bool {
        self.visible && self.active && !self.paused
    }
}
#[derive(Clone)]
pub struct Snapshot {
    pub generation: u64,
    pub sequence: u64,
    pub sampled: Instant,
    pub processes: Arc<Vec<Process>>,
    pub rows: Vec<usize>,
    pub system: SystemSample,
    pub history: Vec<(Option<f64>, Option<f64>)>,
    pub unavailable: usize,
    pub error: Option<String>,
    pub selected_path: Option<String>,
    pub depths: Vec<usize>,
    pub expandable: Vec<bool>,
    pub totals: Vec<super::tree::Totals>,
}
struct State {
    request: Request,
    generation: u64,
    shutdown: bool,
    latest: Option<Arc<Snapshot>>,
}
pub struct Sampler {
    shared: Arc<(Mutex<State>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}
impl Sampler {
    pub fn new() -> std::io::Result<(Self, mpsc::Receiver<()>)> {
        Self::with_storage(None)
    }
    pub fn with_storage(
        storage: Option<std::path::PathBuf>,
    ) -> std::io::Result<(Self, mpsc::Receiver<()>)> {
        let shared = Arc::new((
            Mutex::new(State {
                request: Request::default(),
                generation: 0,
                shutdown: false,
                latest: None,
            }),
            Condvar::new(),
        ));
        let (mut tx, rx) = mpsc::channel(1);
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("tbias-activity".into())
            .spawn(move || {
                let mut engine = Engine::new();
                let mut saved = None;
                let mut settings_error = None;
                let mut processed = u64::MAX;
                let mut was_running = false;
                let mut due = Instant::now();
                loop {
                    let (lock, changed) = &*worker_shared;
                    let mut state = lock.lock().unwrap();
                    while !state.shutdown
                        && state.generation == processed
                        && (!state.request.running() || Instant::now() < due)
                    {
                        state = if state.request.running() {
                            changed
                                .wait_timeout(state, due.saturating_duration_since(Instant::now()))
                                .unwrap()
                                .0
                        } else {
                            changed.wait(state).unwrap()
                        };
                    }
                    if state.shutdown {
                        let prefs = state.request.preferences();
                        drop(state);
                        if let Some(path) = &storage {
                            if saved.as_ref() != Some(&prefs) {
                                if let Err(e) = super::preferences::save(path, &prefs) {
                                    log::error!("Activity Monitor settings: {e}");
                                }
                            }
                        }
                        break;
                    }
                    let request = state.request.clone();
                    let generation = state.generation;
                    drop(state);
                    let running = request.running();
                    if !running {
                        engine.reset_baseline();
                    }
                    if running && (!was_running || Instant::now() >= due) {
                        engine.collect();
                        due = Instant::now() + Duration::from_secs(request.interval.clamp(1, 5));
                    }
                    was_running = running;
                    if generation > 0 {
                        if let Some(path) = &storage {
                            let prefs = request.preferences();
                            if saved.as_ref() != Some(&prefs) {
                                match super::preferences::save(path, &prefs) {
                                    Ok(()) => {
                                        saved = Some(prefs);
                                        settings_error = None;
                                    }
                                    Err(e) => {
                                        settings_error =
                                            Some(format!("Cannot save monitor preferences: {e}"));
                                    }
                                }
                            }
                        }
                    }
                    let mut snapshot = engine.present(&request, generation);
                    snapshot.error = snapshot.error.or_else(|| settings_error.clone());
                    let snapshot = Arc::new(snapshot);
                    let mut state = lock.lock().unwrap();
                    if state.shutdown {
                        drop(state);
                        continue; // Top of loop flushes the latest preferences before exit.
                    }
                    // A newer request makes this result stale. Never publish it.
                    if state.generation == generation {
                        state.latest = Some(snapshot);
                        let _ = tx.try_send(());
                    }
                    processed = generation;
                }
            })?;
        Ok((
            Self {
                shared,
                worker: Some(worker),
            },
            rx,
        ))
    }
    pub fn request(&self, request: Request) -> u64 {
        let mut state = self.shared.0.lock().unwrap();
        if state.request != request {
            state.request = request;
            state.generation += 1;
            self.shared.1.notify_one();
        }
        state.generation
    }
    pub fn latest(&self) -> Option<Arc<Snapshot>> {
        self.shared.0.lock().unwrap().latest.take()
    }
}
impl Drop for Sampler {
    fn drop(&mut self) {
        {
            let mut state = self.shared.0.lock().unwrap();
            state.shutdown = true;
            self.shared.1.notify_one();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
struct Engine {
    #[cfg(target_os = "macos")]
    backend: super::macos::Backend,
    processes: Vec<Process>,
    previous: HashMap<Identity, (u64, Instant)>,
    system: SystemSample,
    ticks: Option<[u32; 4]>,
    sampled: Instant,
    sequence: u64,
    history: VecDeque<(Option<f64>, Option<f64>)>,
    unavailable: usize,
    error: Option<String>,
    collect_ms: f64,
    root_ids: HashMap<u64, (i32, Identity)>,
    uid: u32,
}
impl Engine {
    fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            backend: super::macos::Backend::new(),
            processes: vec![],
            previous: HashMap::new(),
            system: SystemSample::default(),
            ticks: None,
            sampled: Instant::now(),
            sequence: 0,
            history: VecDeque::new(),
            unavailable: 0,
            error: None,
            collect_ms: 0.,
            root_ids: HashMap::new(),
            uid: unsafe { libc::geteuid() },
        }
    }
    fn reset_baseline(&mut self) {
        self.previous.clear();
        self.ticks = None;
    }
    fn collect(&mut self) {
        let start = Instant::now();
        #[cfg(target_os = "macos")]
        {
            let raw = self.backend.sample();
            self.processes = raw.processes;
            self.system = raw.system;
            self.unavailable = raw.unavailable;
            self.error = raw.error;
            for p in &mut self.processes {
                p.cpu = p.cpu_ticks.and_then(|ticks| {
                    self.previous.get(&p.id).and_then(|(old, time)| {
                        model::cpu_percent(
                            *old,
                            ticks,
                            p.sampled.duration_since(*time).as_secs_f64(),
                            self.backend.nanos_per_tick,
                        )
                    })
                });
            }
            self.previous = self
                .processes
                .iter()
                .filter_map(|p| p.cpu_ticks.map(|ticks| (p.id, (ticks, p.sampled))))
                .collect();
            self.system.cpu = if start.duration_since(self.sampled) <= Duration::from_secs(30) {
                self.ticks
                    .zip(raw.ticks)
                    .and_then(|(old, new)| model::machine_cpu(old, new))
            } else {
                None
            };
            self.ticks = raw.ticks;
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.error = Some("Activity Monitor currently supports macOS.".into());
        }
        self.sampled = Instant::now();
        self.sequence += 1;
        let wired = self
            .system
            .memory_wired
            .zip(self.system.memory_total)
            .and_then(|(n, total)| (total > 0).then(|| n as f64 / total as f64 * 100.));
        self.history.push_back((self.system.cpu, wired));
        if self.history.len() > 60 {
            self.history.pop_front();
        }
        self.collect_ms = start.elapsed().as_secs_f64() * 1000.;
    }
    fn present(&mut self, r: &Request, generation: u64) -> Snapshot {
        self.root_ids
            .retain(|token, _| r.roots.iter().any(|root| root.token == *token));
        let mut roots = vec![];
        for root in &r.roots {
            if let Some(p) = self.processes.iter().find(|p| p.id.pid == root.pid) {
                let (pid, id) = self.root_ids.entry(root.token).or_insert((root.pid, p.id));
                if *pid == root.pid && *id == p.id {
                    roots.push((root.clone(), *id));
                }
            }
        }
        let mut processes = self.processes.clone();
        model::associate(&mut processes, &roots);
        let ordered = model::rows(
            &processes,
            &r.query,
            r.scope,
            self.uid,
            r.active_pane,
            r.sort,
            r.descending,
        );
        let forest = super::tree::Forest::new(&processes);
        let (rows, depths, expandable) = if r.tree {
            forest.visible(&processes, &ordered, &r.expanded)
        } else {
            (
                ordered,
                vec![0; processes.len()],
                vec![false; processes.len()],
            )
        };
        #[cfg(target_os = "macos")]
        let selected_path = r
            .selected
            .filter(|id| r.visible && processes.iter().any(|p| p.id == *id))
            .and_then(super::macos::executable);
        #[cfg(not(target_os = "macos"))]
        let selected_path = None;
        Snapshot {
            generation,
            sequence: self.sequence,
            sampled: self.sampled,
            processes: Arc::new(processes),
            rows,
            system: self.system.clone(),
            history: self.history.iter().copied().collect(),
            unavailable: self.unavailable,
            error: self.error.clone(),
            selected_path,
            depths,
            expandable,
            totals: forest.totals,
        }
    }
}

/// Explicit, read-only native diagnostic; runs without creating a GPUI window.
pub fn probe() {
    let mut engine = Engine::new();
    engine.collect();
    let id = std::process::id() as i32;
    let before = engine
        .processes
        .iter()
        .find(|p| p.id.pid == id)
        .expect("cannot read this process; run the probe outside the sandbox")
        .clone();
    let mut memory = vec![0u8; 64 * 1024 * 1024];
    for byte in memory.iter_mut().step_by(4096) {
        *byte = 1;
    }
    let start = Instant::now();
    let mut n = 1u64;
    while start.elapsed() < Duration::from_millis(350) {
        n = std::hint::black_box(n.wrapping_mul(3).wrapping_add(1));
    }
    std::hint::black_box((&memory, n));
    engine.collect();
    let after = engine.processes.iter().find(|p| p.id.pid == id).unwrap();
    assert_eq!(before.id, after.id);
    assert!(
        after.cpu.is_some_and(|n| n > 1. && n < 150.),
        "unexpected CPU {:?}",
        after.cpu
    );
    assert!(
        after.rss.unwrap() > before.rss.unwrap() + 32 * 1024 * 1024,
        "touched allocation absent from RSS"
    );
    assert!(engine.system.cpu.is_some());
    assert!(engine.system.memory_total.is_some());
    println!("ACTIVITY_PROBE_OK: {} processes; {} unavailable/partial; self CPU {:.1}%; RSS {} → {}; collection {:.2} ms; system CPU {:.1}%",engine.processes.len(),engine.unavailable,after.cpu.unwrap(),model::bytes(before.rss),model::bytes(after.rss),engine.collect_ms,engine.system.cpu.unwrap());
    let (sampler, _events) = Sampler::new().unwrap();
    let mut request = Request {
        visible: true,
        interval: 1,
        ..Default::default()
    };
    let live = sampler.request(request.clone());
    let wait_for = |generation| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(s) = sampler.latest() {
                if s.generation == generation {
                    break s;
                }
            }
            assert!(Instant::now() < deadline, "sampler stopped responding");
            thread::sleep(Duration::from_millis(10));
        }
    };
    assert!(wait_for(live).sequence > 0);
    request.paused = true;
    let paused = wait_for(sampler.request(request.clone()));
    thread::sleep(Duration::from_millis(1300));
    assert!(
        sampler.latest().is_none(),
        "paused sampler published another sample"
    );
    request.paused = false;
    let resumed = wait_for(sampler.request(request.clone()));
    assert!(resumed.sequence > paused.sequence);
    assert!(
        resumed.processes.iter().all(|p| p.cpu.is_none()),
        "resume kept a stale CPU baseline"
    );
    request.visible = false;
    wait_for(sampler.request(request));
    drop(sampler);
    println!("ACTIVITY_LIFECYCLE_OK: pause stops sampling; resume resets CPU baseline; close and join succeed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_sampler_does_not_collect_and_stops() {
        let (sampler, _rx) = Sampler::new().unwrap();
        let request = Request {
            query: "query while closed".into(),
            ..Default::default()
        };
        let generation = sampler.request(request);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(s) = sampler.latest() {
                if s.generation == generation {
                    assert_eq!(s.sequence, 0);
                    break;
                }
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        drop(sampler);
    }
    #[test]
    fn shutdown_flushes_the_last_preference_request() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "tbias-preferences-{}-{nonce}.db",
            std::process::id()
        ));
        let (sampler, _rx) = Sampler::with_storage(Some(path.clone())).unwrap();
        sampler.request(Request {
            tree: true,
            sort: Sort::Name,
            ..Default::default()
        });
        drop(sampler);
        let p = super::super::preferences::load(&path).unwrap();
        assert!(p.tree);
        assert_eq!(p.sort, Sort::Name);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cpu_baseline_does_not_survive_pause() {
        let mut e = Engine::new();
        e.previous.insert(
            Identity {
                pid: 1,
                seconds: 1,
                micros: 0,
            },
            (1, Instant::now()),
        );
        e.ticks = Some([1; 4]);
        e.reset_baseline();
        assert!(e.previous.is_empty());
        assert!(e.ticks.is_none());
    }
}
