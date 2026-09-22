//! A bounded, cycle-safe forest. Filtering changes visibility, not subtree totals.
use super::model::{Identity, Process};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Copy, Default, Debug)]
pub struct Totals {
    pub count: usize,
    pub cpu: f64,
    pub rss: u64,
    pub missing_cpu: usize,
    pub missing_rss: usize,
}
pub struct Forest {
    pub parent: Vec<Option<usize>>,
    pub children: Vec<Vec<usize>>,
    pub totals: Vec<Totals>,
}
impl Forest {
    pub fn new(p: &[Process]) -> Self {
        let ids: HashMap<_, _> = p.iter().enumerate().map(|(i, p)| (p.id.pid, i)).collect();
        let mut parent: Vec<_> = p
            .iter()
            .enumerate()
            .map(|(i, row)| {
                ids.get(&row.parent).copied().filter(|j| {
                    *j != i
                        && (p[*j].id.seconds, p[*j].id.micros) <= (row.id.seconds, row.id.micros)
                })
            })
            .collect();
        let mut state = vec![0u8; p.len()];
        for i in 0..p.len() {
            if state[i] != 0 {
                continue;
            }
            let mut path = vec![];
            let mut node = Some(i);
            while let Some(n) = node {
                if state[n] == 2 {
                    break;
                }
                if state[n] == 1 {
                    parent[n] = None;
                    break;
                }
                state[n] = 1;
                path.push(n);
                node = parent[n];
            }
            for n in path {
                state[n] = 2;
            }
        }
        let mut children = vec![vec![]; p.len()];
        let mut roots = vec![];
        for (i, parent) in parent.iter().enumerate() {
            if let Some(parent) = parent {
                children[*parent].push(i);
            } else {
                roots.push(i);
            }
        }
        let mut order = vec![];
        let mut stack = roots;
        while let Some(i) = stack.pop() {
            order.push(i);
            stack.extend(children[i].iter().copied());
        }
        let mut totals: Vec<_> = p
            .iter()
            .map(|p| Totals {
                count: 1,
                cpu: p.cpu.unwrap_or(0.),
                rss: p.rss.unwrap_or(0),
                missing_cpu: usize::from(p.cpu.is_none()),
                missing_rss: usize::from(p.rss.is_none()),
            })
            .collect();
        for i in order.into_iter().rev() {
            if let Some(j) = parent[i] {
                let t = totals[i];
                totals[j].count += t.count;
                totals[j].cpu += t.cpu;
                totals[j].rss = totals[j].rss.saturating_add(t.rss);
                totals[j].missing_cpu += t.missing_cpu;
                totals[j].missing_rss += t.missing_rss;
            }
        }
        Self {
            parent,
            children,
            totals,
        }
    }
    pub fn visible(
        &self,
        p: &[Process],
        ordered: &[usize],
        expanded: &HashSet<Identity>,
    ) -> (Vec<usize>, Vec<usize>, Vec<bool>) {
        let mut rank = vec![usize::MAX; p.len()];
        for (r, i) in ordered.iter().enumerate() {
            rank[*i] = r;
        }
        let mut children = self.children.clone();
        for list in &mut children {
            list.retain(|i| rank[*i] != usize::MAX);
            list.sort_by_key(|i| rank[*i]);
        }
        let mut stack: Vec<_> = ordered
            .iter()
            .filter(|i| self.parent[**i].is_none_or(|j| rank[j] == usize::MAX))
            .rev()
            .map(|i| (*i, 0))
            .collect();
        let mut rows = vec![];
        let mut depth = vec![0; p.len()];
        let mut expandable = vec![false; p.len()];
        while let Some((i, d)) = stack.pop() {
            rows.push(i);
            depth[i] = d;
            expandable[i] = !children[i].is_empty();
            if expanded.contains(&p[i].id) {
                stack.extend(children[i].iter().rev().map(|c| (*c, d + 1)));
            }
        }
        (rows, depth, expandable)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn process(pid: i32, parent: i32) -> Process {
        Process {
            id: Identity {
                pid,
                seconds: 1,
                micros: 0,
            },
            parent,
            uid: 1,
            owner: String::new(),
            name: pid.to_string(),
            state: String::new(),
            cpu: Some(1.),
            rss: Some(10),
            threads: None,
            cpu_ticks: None,
            sampled: std::time::Instant::now(),
            shell: None,
        }
    }
    #[test]
    fn collapse_filter_and_totals_do_not_duplicate() {
        let mut p = vec![process(1, 0), process(2, 1), process(3, 2), process(4, 1)];
        p[2].cpu = None;
        let f = Forest::new(&p);
        let expanded = [p[0].id].into_iter().collect();
        assert_eq!(f.visible(&p, &[0, 3, 1, 2], &expanded).0, vec![0, 3, 1]);
        assert_eq!(f.visible(&p, &[2], &expanded).0, vec![2]);
        assert_eq!(f.totals[0].count, 4);
        assert_eq!(f.totals[0].cpu, 3.);
        assert_eq!(f.totals[0].rss, 40);
        assert_eq!(f.totals[0].missing_cpu, 1);
    }
    #[test]
    fn cycles_and_deep_trees_are_bounded() {
        let p = vec![process(1, 2), process(2, 1), process(3, 3)];
        let f = Forest::new(&p);
        let all = p.iter().map(|p| p.id).collect();
        assert_eq!(f.visible(&p, &[0, 1, 2], &all).0.len(), 3);
        let p: Vec<_> = (1..=10000).map(|i| process(i, i - 1)).collect();
        let f = Forest::new(&p);
        assert_eq!(f.totals[0].count, 10000);
        let all = p.iter().map(|p| p.id).collect();
        assert_eq!(
            f.visible(&p, &(0..10000).collect::<Vec<_>>(), &all).0.len(),
            10000
        );
    }
}
