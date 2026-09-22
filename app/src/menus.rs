use gpui::{actions, App, KeyBinding, Menu, MenuItem, SystemMenuType};
actions!(
    native,
    [
        Quit,
        About,
        Settings,
        NewTab,
        ClosePane,
        SplitHorizontal,
        SplitVertical,
        Zoom,
        NextTab,
        PreviousTab,
        Copy,
        Paste,
        Flip,
        Prompts,
        SendNextPrompt,
        ActivityMonitor
    ]
);
pub fn install(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
    cx.set_menus(vec![
        Menu {
            disabled: false,
            name: "t-bias".into(),
            items: vec![
                MenuItem::action("About t-bias", About),
                MenuItem::action("Settings…", Settings),
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("Quit t-bias", Quit),
            ],
        },
        Menu {
            disabled: false,
            name: "File".into(),
            items: vec![
                MenuItem::action("New Tab", NewTab),
                MenuItem::action("Close Pane", ClosePane),
            ],
        },
        Menu {
            disabled: false,
            name: "Edit".into(),
            items: vec![
                MenuItem::action("Copy", Copy),
                MenuItem::action("Paste", Paste),
            ],
        },
        Menu {
            disabled: false,
            name: "View".into(),
            items: vec![
                MenuItem::action("Split Side by Side", SplitHorizontal),
                MenuItem::action("Split Above and Below", SplitVertical),
                MenuItem::action("Zoom Pane", Zoom),
                MenuItem::action("Previous Tab", PreviousTab),
                MenuItem::action("Next Tab", NextTab),
                MenuItem::separator(),
                MenuItem::action("Files / Terminal", Flip),
                MenuItem::action("Prompt Library", Prompts),
                MenuItem::action("Activity Monitor", ActivityMonitor),
                MenuItem::action("Send Next Prompt", SendNextPrompt),
            ],
        },
    ]);
}
