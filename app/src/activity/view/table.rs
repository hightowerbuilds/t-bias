//! Kit's virtualized DataTable; process identity remains owned by the monitor.
use super::*;
use gpui::{App, SharedString, WeakEntity};
use gpui_kit::component::{
    table::{Column, DataTable, TableDelegate, TableEvent, TableState},
    Sizable,
};

const COLUMNS: [(Sort, &str, f32); 7] = [
    (Sort::Name, "Process", 220.),
    (Sort::Pid, "PID", 75.),
    (Sort::Owner, "User", 110.),
    (Sort::Cpu, "CPU %", 90.),
    (Sort::Memory, "Resident Memory", 150.),
    (Sort::Threads, "Threads", 85.),
    (Sort::State, "State", 105.),
];
pub(super) struct Processes {
    owner: WeakEntity<ActivityMonitor>,
    snapshot: Option<Arc<Snapshot>>,
    request: Request,
    columns: Vec<Sort>,
    widths: std::collections::BTreeMap<Sort, gpui::Pixels>,
    seen_rows: std::collections::HashSet<usize>,
    measure_rendering: bool,
}
impl Processes {
    fn row(&self, row: usize) -> Option<(usize, &model::Process)> {
        let snapshot = self.snapshot.as_ref()?;
        let index = *snapshot.rows.get(row)?;
        Some((index, &snapshot.processes[index]))
    }
    fn index_for(&self, id: Identity) -> Option<usize> {
        self.snapshot
            .as_ref()?
            .rows
            .iter()
            .position(|index| self.snapshot.as_ref().unwrap().processes[*index].id == id)
    }
}
impl TableDelegate for Processes {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }
    fn rows_count(&self, _: &App) -> usize {
        self.snapshot.as_ref().map_or(0, |s| s.rows.len())
    }
    fn column(&self, index: usize, _: &App) -> Column {
        let sort = self.columns[index];
        let (_, name, width) = COLUMNS.iter().find(|(s, _, _)| *s == sort).unwrap();
        Column::new(format!("{sort:?}"), *name)
            .width(self.widths.get(&sort).copied().unwrap_or(px(*width)))
            .min_width(px(65.))
            .resizable(true)
    }
    fn render_th(
        &mut self,
        index: usize,
        _: &mut Window,
        _: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let sort = self.columns[index];
        let (_, name, _) = COLUMNS.iter().find(|(s, _, _)| *s == sort).unwrap();
        let label = if self.request.sort == sort {
            format!(
                "{name} {}",
                if self.request.descending {
                    "↓"
                } else {
                    "↑"
                }
            )
        } else {
            name.to_string()
        };
        let owner = self.owner.clone();
        let help_owner = self.owner.clone();
        div()
            .flex()
            .items_center()
            .gap_1()
            .child(
                crate::ui::button(("sort", index), label).on_click(move |_, _, cx| {
                    let _ = owner.update(cx, |this, cx| {
                        if this.request.sort == sort {
                            this.request.descending = !this.request.descending;
                        } else {
                            this.request.sort = sort;
                            this.request.descending =
                                matches!(sort, Sort::Cpu | Sort::Memory | Sort::Threads);
                        }
                        this.submit();
                        cx.notify();
                    });
                }),
            )
            .when(matches!(sort, Sort::Name | Sort::Cpu | Sort::Memory), |d| {
                d.child(
                    crate::ui::button(("help", index), "?")
                        .tooltip("Learn about this metric")
                        .on_click(move |_, _, cx| {
                            let _ = help_owner.update(cx, |this, cx| {
                                this.lesson = match sort {
                                    Sort::Cpu => 1,
                                    Sort::Memory => 2,
                                    _ => 0,
                                };
                                this.lesson_scroll.set_offset(gpui::point(px(0.), px(0.)));
                                this.show_surface(Surface::Learn, cx);
                            });
                            cx.stop_propagation();
                        }),
                )
            })
    }
    fn render_tr(
        &mut self,
        row: usize,
        _: &mut Window,
        _: &mut Context<TableState<Self>>,
    ) -> gpui::Stateful<gpui::Div> {
        if self.measure_rendering {
            self.seen_rows.insert(row);
        }
        let id = self.row(row).map(|(_, p)| p.id).unwrap();
        div().id(SharedString::from(format!(
            "process-{}-{}-{}",
            id.pid, id.seconds, id.micros
        )))
    }
    fn render_td(
        &mut self,
        row: usize,
        column: usize,
        _: &mut Window,
        _: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let Some((index, p)) = self.row(row) else {
            return div().into_any_element();
        };
        let sort = self.columns[column];
        if sort == Sort::Name {
            let s = self.snapshot.as_ref().unwrap();
            let id = p.id;
            let owner = self.owner.clone();
            return div()
                .flex()
                .items_center()
                .overflow_hidden()
                .child(
                    div()
                        .w(px((s.depths[index].min(8) * 12) as f32))
                        .flex_shrink_0(),
                )
                .when(s.expandable[index], |d| {
                    d.child(
                        crate::ui::button(
                            ("expand", index),
                            if self.request.expanded.contains(&id) {
                                "▾"
                            } else {
                                "▸"
                            },
                        )
                        .tooltip("Expand / collapse process family")
                        .on_click(move |_, _, cx| {
                            let _ = owner.update(cx, |this, cx| {
                                if !this.request.expanded.remove(&id) {
                                    this.request.expanded.insert(id);
                                }
                                this.submit();
                                cx.notify();
                            });
                            cx.stop_propagation();
                        }),
                    )
                })
                .child(div().whitespace_nowrap().child(p.name.clone()))
                .into_any_element();
        }
        let text = match sort {
            Sort::Pid => p.id.pid.to_string(),
            Sort::Owner => p.owner.clone(),
            Sort::Cpu => p
                .cpu
                .map(|v| format!("{v:.1}"))
                .unwrap_or_else(|| "—".into()),
            Sort::Memory => model::bytes(p.rss),
            Sort::Threads => p
                .threads
                .map(|v| v.to_string())
                .unwrap_or_else(|| "—".into()),
            Sort::State => p.state.clone(),
            Sort::Name => unreachable!(),
        };
        div()
            .overflow_hidden()
            .whitespace_nowrap()
            .child(text)
            .into_any_element()
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        _: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        div()
            .p_4()
            .child(if self.snapshot.as_ref().is_none_or(|s| s.sequence == 0) {
                "Waiting for the first sample…"
            } else {
                "No processes match this scope and search."
            })
    }
}
impl ActivityMonitor {
    pub(super) fn process_table(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if self.table.is_none() {
            let owner = cx.weak_entity();
            let delegate = Processes {
                owner,
                snapshot: self.snapshot.clone(),
                request: self.request.clone(),
                columns: self.request.columns.iter().copied().collect(),
                widths: Default::default(),
                seen_rows: Default::default(),
                measure_rendering: std::env::args().any(|a| a == "--kit-smoke"),
            };
            let table = cx.new(|cx| {
                TableState::new(delegate, window, cx)
                    .col_movable(false)
                    .col_selectable(false)
                    .loop_selection(false)
            });
            self.table_events = Some(cx.subscribe(&table, |this, table, event, cx| match event {
                TableEvent::SelectRow(index) => {
                    let id = table.read(cx).delegate().row(*index).map(|(_, p)| p.id);
                    if id != this.request.selected {
                        this.request.selected = id;
                        this.submit();
                        cx.notify();
                    }
                }
                TableEvent::ClearSelection => {
                    if this.request.selected.take().is_some() {
                        this.submit();
                        cx.notify();
                    }
                }
                TableEvent::ColumnWidthsChanged(widths) => {
                    table.update(cx, |t, _| {
                        let d = t.delegate_mut();
                        for (sort, width) in d.columns.iter().zip(widths) {
                            d.widths.insert(*sort, *width);
                        }
                    });
                }
                _ => {}
            }));
            self.table = Some(table);
        }
        let table = self.table.as_ref().unwrap();
        let request = self.request.clone();
        let snapshot = self.snapshot.clone();
        table.update(cx, |t, cx| {
            let d = t.delegate_mut();
            let columns: Vec<_> = request.columns.iter().copied().collect();
            let changed_columns = d.columns != columns;
            let changed_snapshot = match (&d.snapshot, &snapshot) {
                (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
                (None, None) => false,
                _ => true,
            };
            if !changed_columns && !changed_snapshot && d.request == request {
                return;
            }
            let preserve_scroll =
                d.request.selected.is_some() && d.request.selected == request.selected;
            d.columns = columns;
            d.snapshot = snapshot;
            d.request = request;
            let selected = d.request.selected.and_then(|id| d.index_for(id));
            if changed_columns {
                t.refresh(cx);
            }
            // Table row indices are transient. Re-resolve PID + start identity
            // after every adoption; never preserve selection by index alone.
            if t.selected_row() != selected {
                if let Some(index) = selected {
                    let pending = t.vertical_scroll_handle.0.borrow().deferred_scroll_to_item;
                    t.set_selected_row(index, cx);
                    // Snapshot resorting must not drag the viewport back to the
                    // selected process while the user is reading other rows.
                    if preserve_scroll {
                        t.vertical_scroll_handle
                            .0
                            .borrow_mut()
                            .deferred_scroll_to_item = pending;
                    }
                } else {
                    t.clear_selection(cx);
                }
            }
            cx.notify();
        });
        DataTable::new(table).small().bordered(false)
    }
}

impl ActivityMonitor {
    pub fn kit_table_smoke(&mut self, phase: usize, cx: &mut Context<Self>) {
        match phase {
            0 => {
                self.sampler.take(); // Fixture owns snapshots after this point.
                let mut snapshot = (**self.snapshot.as_ref().expect("live seed snapshot")).clone();
                let seed = snapshot.processes.first().unwrap().clone();
                let rows: Vec<_> = (0..10_000)
                    .map(|i| {
                        let mut p = seed.clone();
                        p.id = Identity {
                            pid: 100_000 + i,
                            seconds: 100,
                            micros: 0,
                        };
                        p.parent = 0;
                        p.name = format!("Fixture {i} 中文");
                        p
                    })
                    .collect();
                snapshot.processes = Arc::new(rows);
                snapshot.rows = (0..10_000).collect();
                snapshot.depths = vec![0; 10_000];
                snapshot.expandable = vec![false; 10_000];
                snapshot.totals = vec![Default::default(); 10_000];
                self.request.selected = Some(snapshot.processes[10].id);
                self.snapshot = Some(Arc::new(snapshot));
                self.table.as_ref().unwrap().update(cx, |t, cx| {
                    t.delegate_mut().seen_rows.clear();
                    cx.notify();
                });
                cx.notify();
            }
            1 => {
                let table = self.table.as_ref().unwrap().read(cx);
                assert_eq!(table.selected_row(), Some(10));
                let seen = table.delegate().seen_rows.len();
                assert!(
                    seen > 0 && seen < 200,
                    "10,000-row table did not virtualize: {seen} rows"
                );
                let mut snapshot = (**self.snapshot.as_ref().unwrap()).clone();
                snapshot.rows.reverse();
                self.snapshot = Some(Arc::new(snapshot));
                cx.notify();
            }
            2 => {
                let table = self.table.as_ref().unwrap().read(cx);
                assert_eq!(
                    table.selected_row(),
                    Some(9_989),
                    "selection followed row index after sort"
                );
                assert!(
                    table
                        .vertical_scroll_handle
                        .0
                        .borrow()
                        .base_handle
                        .offset()
                        .y
                        > px(-1000.),
                    "snapshot resort jumped the viewport"
                );
                let mut snapshot = (**self.snapshot.as_ref().unwrap()).clone();
                Arc::make_mut(&mut snapshot.processes)[10].id.seconds += 1;
                self.snapshot = Some(Arc::new(snapshot));
                cx.notify();
            }
            3 => {
                assert_eq!(
                    self.table.as_ref().unwrap().read(cx).selected_row(),
                    None,
                    "selection followed a reused PID"
                );
                self.request.columns.remove(&Sort::Owner);
                cx.notify();
            }
            4 => {
                assert!(!self
                    .table
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .delegate()
                    .columns
                    .contains(&Sort::Owner));
                log::info!("KIT_TABLE_SMOKE_OK: 10,000 virtualized rows, identity selection across sorting, PID reuse clears selection, hidden columns");
            }
            _ => {}
        }
    }
}
