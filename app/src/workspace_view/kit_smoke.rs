//! Native migration checks: edited prompts/settings must never leak into PTYs.
use super::*;
use crate::config;
impl WorkspaceView {
    pub fn start_kit_smoke(&mut self, window: &Window, cx: &mut Context<Self>) {
        assert!(std::env::var_os("TBIAS_DATA_DIR").is_some());
        self.pad_hub.take();
        cx.spawn_in(window, async move |this, cx| {
            let mut pid = None;
            let mut before = String::new();
            for step in 0..43 {
                cx.background_executor().timer(Duration::from_millis(450)).await;
                this.update_in(cx, |this, window, cx| {
                    let text = |this: &Self, cx: &App| {
                        let pane = this.active_pane().unwrap();
                        let handle = pane.read(cx).terminal.as_ref().unwrap().handle();
                        let value = handle.term().lock().grid().display_iter().map(|c| c.cell.c).collect::<String>(); value
                    };
                    match step {
                        0 => { pid = this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().pid(); this.navigate(Destination::Prompts, cx); }
                        2 => { before = text(this, cx); this.prompt_panel.update(cx, |p,cx| p.kit_smoke(0,window,cx)); }
                        3 => this.prompt_panel.update(cx, |p,cx| p.kit_smoke(1,window,cx)),
                        4 => { assert_eq!(text(this,cx),before,"prompt editing wrote to PTY"); this.prompt_panel.update(cx, |p,cx| p.kit_smoke(2,window,cx)); }
                        5 => this.prompt_panel.update(cx, |p,cx| p.kit_smoke(3,window,cx)),
                        6 => this.navigate(Destination::Files,cx),
                        7 => this.navigate(Destination::Prompts,cx),
                        8 => this.prompt_panel.update(cx, |p,cx| p.kit_smoke(4,window,cx)),
                        9 => this.prompt_panel.update(cx, |p,cx| p.kit_smoke(5,window,cx)),
                        11 => {
                            let screen = text(this,cx);
                            assert!(screen.contains("KIT_SEND_"),"queued prompt was not inserted");
                            let path = config::data_dir().unwrap().join("must-not-exist");
                            assert!(!path.exists(),"Send submitted Enter");
                            this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().handle().input(vec![3]);
                            this.navigate(Destination::Settings,cx);
                        }
                        13 => { before = text(this,cx); this.settings.update(cx,|s,cx| s.kit_smoke(0,window,cx)); }
                        14 => this.settings.update(cx,|s,cx| s.kit_smoke(1,window,cx)),
                        15 => this.settings.update(cx,|s,cx| s.kit_smoke(2,window,cx)),
                        16 => { assert_eq!(text(this,cx),before,"settings wrote to PTY"); this.action("close_pane",cx); assert!(!this.show_settings); assert_eq!(this.sessions.len(),1); }
                        17 => { this.navigate(Destination::Prompts,cx); window.resize(gpui::size(px(640.),px(420.))); }
                        19 => this.prompt_panel.update(cx, |p,cx| p.kit_smoke(6,window,cx)),
                        20 => { this.prompt_panel.update(cx, |p,cx| p.kit_smoke(7,window,cx)); this.navigate(Destination::Settings,cx); },
                        22 => this.navigate(Destination::Activity,cx),
                        27 => this.activity.as_ref().unwrap().update(cx, |m,cx|m.kit_table_smoke(0,cx)),
                        29 => this.activity.as_ref().unwrap().update(cx, |m,cx|m.kit_table_smoke(1,cx)),
                        31 => this.activity.as_ref().unwrap().update(cx, |m,cx|m.kit_table_smoke(2,cx)),
                        33 => this.activity.as_ref().unwrap().update(cx, |m,cx|m.kit_table_smoke(3,cx)),
                        35 => this.activity.as_ref().unwrap().update(cx, |m,cx|m.kit_table_smoke(4,cx)),
                        37 => this.navigate(Destination::Terminal,cx),
                        40 => {
                            assert_eq!(this.active_pane().unwrap().read(cx).terminal.as_ref().unwrap().pid(),pid);
                            assert_eq!(this.sessions.len(),1);
                            this.save(cx);
                            log::info!("KIT_APP_SMOKE_OK: mounted prompt input, draft survival, save/queue/send without Enter, PTY isolation, settings Apply/Discard/conflict, compact layout, shell survival");
                        }
                        _ => {}
                    }
                }).expect("Kit smoke window disappeared");
            }
            let _ = cx.update(|_, cx| cx.quit());
        }).detach();
    }
}
