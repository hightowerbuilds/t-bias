//! Pure process identity, sampling math and presentation. No GPUI or OS calls.
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    time::Instant,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Identity {
    pub pid: i32,
    pub seconds: u64,
    pub micros: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellRoot {
    pub tab: u64,
    pub pane: u64,
    pub token: u64,
    pub pid: i32,
    pub label: String,
}
#[derive(Clone, Debug)]
pub struct Process {
    pub id: Identity,
    pub parent: i32,
    pub uid: u32,
    pub owner: String,
    pub name: String,
    pub state: String,
    pub cpu: Option<f64>,
    pub rss: Option<u64>,
    pub threads: Option<u32>,
    pub cpu_ticks: Option<u64>,
    pub sampled: Instant,
    pub shell: Option<ShellRoot>,
}
#[derive(Clone, Debug, Default)]
pub struct SystemSample {
    pub cpu: Option<f64>,
    pub memory_total: Option<u64>,
    pub memory_active: Option<u64>,
    pub memory_wired: Option<u64>,
    pub memory_compressed: Option<u64>,
    pub memory_free: Option<u64>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    #[default]
    All,
    Mine,
    Workspace,
    Pane,
}
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    serde::Serialize,
    serde::Deserialize,
    PartialOrd,
    Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum Sort {
    Name,
    Pid,
    Owner,
    #[default]
    Cpu,
    Memory,
    Threads,
    State,
}

pub fn cpu_percent(old: u64, new: u64, elapsed: f64, nanos_per_tick: f64) -> Option<f64> {
    if !(0.05..=30.).contains(&elapsed) || !nanos_per_tick.is_finite() || nanos_per_tick <= 0. {
        return None;
    }
    let delta = new.checked_sub(old)?;
    Some(delta as f64 * nanos_per_tick / 1_000_000_000. / elapsed * 100.)
}
pub fn machine_cpu(old: [u32; 4], new: [u32; 4]) -> Option<f64> {
    // A wrap/reset invalidates one interval; never turn it into a huge spike.
    let mut delta = [0u64; 4];
    for i in 0..4 {
        delta[i] = new[i].checked_sub(old[i])? as u64;
    }
    let total: u64 = delta.iter().sum();
    (total > 0).then(|| (total - delta[2]) as f64 / total as f64 * 100.)
}
pub fn associate(processes: &mut [Process], roots: &[(ShellRoot, Identity)]) {
    let parents: HashMap<_, _> = processes
        .iter()
        .map(|p| (p.id.pid, (p.id, p.parent)))
        .collect();
    let root_ids: HashMap<_, _> = roots.iter().map(|(root, id)| (*id, root)).collect();
    for process in processes {
        process.shell = None;
        let mut next = process.id.pid;
        let mut seen = HashSet::new();
        while seen.insert(next) {
            let Some((identity, parent)) = parents.get(&next) else {
                break;
            };
            if let Some(root) = root_ids.get(identity) {
                process.shell = Some((*root).clone());
                break;
            }
            // A parent born after its child indicates a reused PID, not ancestry.
            if let Some((parent_id, _)) = parents.get(parent) {
                if (parent_id.seconds, parent_id.micros) > (identity.seconds, identity.micros) {
                    break;
                }
            }
            next = *parent;
        }
    }
}
fn optional<T: PartialOrd>(a: Option<T>, b: Option<T>, descending: bool) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => {
            let order = a.partial_cmp(&b).unwrap_or(Ordering::Equal);
            if descending {
                order.reverse()
            } else {
                order
            }
        }
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        _ => Ordering::Equal,
    }
}
pub fn rows(
    processes: &[Process],
    query: &str,
    scope: Scope,
    uid: u32,
    active: Option<(u64, u64)>,
    sort: Sort,
    descending: bool,
) -> Vec<usize> {
    let query = query.trim().to_lowercase();
    let mut rows: Vec<_> = processes
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            (query.is_empty()
                || p.name.to_lowercase().contains(&query)
                || p.id.pid.to_string().contains(&query))
                && match scope {
                    Scope::All => true,
                    Scope::Mine => p.uid == uid,
                    Scope::Workspace => p.shell.is_some(),
                    Scope::Pane => p
                        .shell
                        .as_ref()
                        .is_some_and(|s| Some((s.tab, s.pane)) == active),
                }
        })
        .map(|(i, _)| i)
        .collect();
    rows.sort_by(|a, b| {
        let (a, b) = (&processes[*a], &processes[*b]);
        let order = match sort {
            Sort::Cpu => return optional(a.cpu, b.cpu, descending).then(a.id.cmp(&b.id)),
            Sort::Memory => return optional(a.rss, b.rss, descending).then(a.id.cmp(&b.id)),
            Sort::Threads => {
                return optional(a.threads, b.threads, descending).then(a.id.cmp(&b.id))
            }
            Sort::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            Sort::Pid => a.id.pid.cmp(&b.id.pid),
            Sort::Owner => a.owner.cmp(&b.owner),
            Sort::State => a.state.cmp(&b.state),
        };
        (if descending { order.reverse() } else { order }).then(a.id.cmp(&b.id))
    });
    rows
}
pub fn bytes(value: Option<u64>) -> String {
    match value {
        None => "—".into(),
        Some(n) if n >= 1 << 30 => format!("{:.2} GiB", n as f64 / (1u64 << 30) as f64),
        Some(n) => format!("{:.1} MiB", n as f64 / (1u64 << 20) as f64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn process(pid: i32, parent: i32, seconds: u64, cpu: Option<f64>) -> Process {
        Process {
            id: Identity {
                pid,
                seconds,
                micros: 0,
            },
            parent,
            uid: 501,
            owner: "user".into(),
            name: format!("job {pid}"),
            state: "Runnable".into(),
            cpu,
            rss: Some(1024),
            threads: Some(1),
            cpu_ticks: None,
            sampled: Instant::now(),
            shell: None,
        }
    }
    #[test]
    fn cpu_units_resets_and_multicore() {
        assert_eq!(cpu_percent(10, 2_000_000_010, 1., 1.), Some(200.));
        assert_eq!(cpu_percent(0, 24_000_000, 1., 125. / 3.), Some(100.));
        assert_eq!(cpu_percent(10, 9, 1., 1.), None);
        assert_eq!(cpu_percent(0, 10, 31., 1.), None);
        assert_eq!(cpu_percent(10, 10, 1., 1.), Some(0.));
        assert_eq!(machine_cpu([0; 4], [25, 25, 50, 0]), Some(50.));
        assert_eq!(machine_cpu([u32::MAX; 4], [0; 4]), None);
    }
    #[test]
    fn sorting_keeps_unknown_last_and_filters() {
        let p = vec![
            process(2, 1, 1, None),
            process(3, 1, 1, Some(10.)),
            process(4, 1, 1, Some(20.)),
        ];
        assert_eq!(
            rows(&p, "", Scope::All, 501, None, Sort::Cpu, true),
            vec![2, 1, 0]
        );
        assert_eq!(
            rows(&p, "", Scope::All, 501, None, Sort::Cpu, false),
            vec![1, 2, 0]
        );
        assert_eq!(
            rows(&p, "JOB 3", Scope::Mine, 501, None, Sort::Name, false),
            vec![1]
        );
        assert!(rows(&p, "", Scope::Mine, 502, None, Sort::Name, false).is_empty());
    }
    #[test]
    fn ancestry_rejects_reuse_and_cycles() {
        let mut p = vec![
            process(10, 1, 2, None),
            process(11, 10, 3, None),
            process(12, 10, 1, None),
            process(20, 21, 1, None),
            process(21, 20, 1, None),
        ];
        let root = ShellRoot {
            tab: 1,
            pane: 1,
            token: 1,
            pid: 10,
            label: "Terminal".into(),
        };
        let id = p[0].id;
        associate(&mut p, &[(root.clone(), id)]);
        assert!(p[0].shell.is_some() && p[1].shell.is_some());
        assert!(p[2..].iter().all(|p| p.shell.is_none()));
        associate(&mut p, &[(root, Identity { seconds: 0, ..id })]);
        assert!(p.iter().all(|p| p.shell.is_none()));
    }
    #[test]
    fn large_inventory_and_nested_terminal_scopes() {
        let mut p: Vec<_> = (1..=10000)
            .map(|i| process(i, i - 1, i as u64, Some(i as f64)))
            .collect();
        // Keep the large fixture flat except for a nested terminal subtree.
        for row in &mut p {
            row.parent = 1;
        }
        p[2].parent = 2;
        let root = ShellRoot {
            tab: 1,
            pane: 1,
            token: 1,
            pid: 1,
            label: "outer".into(),
        };
        let nested = ShellRoot {
            pane: 2,
            token: 2,
            pid: 2,
            label: "inner".into(),
            ..root.clone()
        };
        let roots = vec![(root, p[0].id), (nested, p[1].id)];
        associate(&mut p, &roots);
        assert_eq!(p[2].shell.as_ref().unwrap().pane, 2);
        assert_eq!(
            rows(&p, "", Scope::Pane, 501, Some((1, 2)), Sort::Pid, false),
            vec![1, 2]
        );
        let ordered = rows(&p, "", Scope::Workspace, 501, None, Sort::Cpu, true);
        assert_eq!(ordered.len(), 10000);
        assert_eq!((ordered[0], ordered[9999]), (9999, 0));
    }
}
