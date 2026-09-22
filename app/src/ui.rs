//! Shared Kit controls and appearance; terminal ANSI colors remain independent.
use gpui::{px, App, ElementId, SharedString};
use gpui_kit::component::{button::Button, Sizable, Theme, ThemeMode};

pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    let label = label.into();
    Button::new(id)
        .label(label.clone())
        .accessibility_label(label)
        .small()
}

pub fn init(config: &crate::config::Config, cx: &mut App) {
    Theme::change(
        if config.theme == "light" {
            ThemeMode::Light
        } else {
            ThemeMode::Dark
        },
        None,
        cx,
    );
    let terminal = crate::terminal_view::Theme::from_config(config);
    let theme = Theme::global_mut(cx);
    theme.font_size = px(13.);
    theme.mono_font_family = config.font_family.clone().into();
    let mut tokens = theme.semantic_tokens();
    let mut bg = terminal.bg;
    bg.a = 1.;
    tokens.colors.background = bg.into();
    tokens.colors.foreground = terminal.fg.into();
    tokens.colors.surface = terminal.chrome().into();
    tokens.colors.surface_foreground = terminal.fg.into();
    tokens.colors.primary = terminal.cursor.into();
    tokens.colors.muted_foreground = terminal.muted().into();
    tokens.colors.border = terminal.raised().into();
    tokens.colors.input = terminal.raised().into();
    tokens.colors.ring = terminal.cursor.into();
    tokens.colors.accent = terminal.raised().into();
    tokens.colors.accent_foreground = terminal.fg.into();
    theme.apply_semantic_tokens(&tokens);
    // DataTable and Button still use Kit's component-specific tokens.
    theme.table = bg.into();
    theme.table_head = terminal.chrome().into();
    theme.table_head_foreground = terminal.fg.into();
    theme.table_hover = terminal.chrome().into();
    theme.table_active = terminal.raised().into();
    theme.table_even = bg.into();
    theme.table_row_border = terminal.raised().into();
    theme.button = terminal.chrome().into();
    theme.button_foreground = terminal.fg.into();
    theme.button_hover = terminal.raised().into();
    theme.button_active = terminal.raised().into();
    theme.tokens.table = theme.table.into();
    theme.tokens.table_head = theme.table_head.into();
    theme.tokens.table_hover = theme.table_hover.into();
    theme.tokens.table_active = theme.table_active.into();
    theme.tokens.table_even = theme.table_even.into();
    theme.tokens.button = theme.button.into();
    theme.tokens.button_hover = theme.button_hover.into();
    theme.tokens.button_active = theme.button_active.into();
    Theme::sync_base(cx);
}
