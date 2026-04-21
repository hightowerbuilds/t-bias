// ---------------------------------------------------------------------------
// screen.rs — Rust-native terminal screen buffer + VT processor
// ---------------------------------------------------------------------------
// Replaces the JavaScript Parser/Screen/VirtualCanvas pipeline with a Rust
// implementation backed by the `vte` crate. The PTY reader thread feeds raw
// bytes through the VT parser, which updates a ScreenBuffer. The frontend
// requests frame snapshots via IPC and renders them to canvas.
//
// Architecture:
//   PTY reader thread → vte::Parser → ScreenBuffer (cells + scrollback)
//   Frontend (RAF) → IPC get_frame → serialized cell grid → Canvas draw

use serde::Serialize;
use std::sync::{Arc, Mutex};
use vte::{Params, Perform};

// ---------------------------------------------------------------------------
// Cell data — one per grid position
// ---------------------------------------------------------------------------

/// Packed cell attributes (matches the frontend's bit layout).
#[derive(Clone, Copy, Default, Serialize)]
pub struct CellAttrs {
    pub bold: bool,
    pub faint: bool,
    pub italic: bool,
    pub underline: u8, // 0=none, 1=single, 2=double, 3=curly, 4=dotted, 5=dashed
    pub blink: bool,
    pub inverse: bool,
    pub hidden: bool,
    pub strikethrough: bool,
    pub overline: bool,
    pub wide: bool,
}

/// A color value — default, palette index, or RGB.
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "type")]
pub enum Color {
    Default,
    Palette { index: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

impl Default for Color {
    fn default() -> Self {
        Color::Default
    }
}

/// A single terminal cell.
#[derive(Clone, Default, Serialize)]
pub struct Cell {
    /// The character in this cell (empty string for blank/spacer).
    pub char: String,
    pub fg: Color,
    pub bg: Color,
    pub attrs: CellAttrs,
}

// ---------------------------------------------------------------------------
// ScreenBuffer — the terminal grid
// ---------------------------------------------------------------------------

pub struct ScreenBuffer {
    pub cols: usize,
    pub rows: usize,
    /// Row-major cell grid: cells[row * cols + col]
    cells: Vec<Cell>,
    /// Scrollback buffer (oldest first)
    scrollback: Vec<Vec<Cell>>,
    scrollback_limit: usize,

    // Cursor state
    cursor_x: usize,
    cursor_y: usize,
    cursor_visible: bool,

    // Current pen (attributes for new characters)
    pen_fg: Color,
    pen_bg: Color,
    pen_attrs: CellAttrs,

    // Scroll region
    scroll_top: usize,
    scroll_bottom: usize,

    // Modes
    auto_wrap: bool,
    wrap_pending: bool,
    alternate_screen: bool,
    origin_mode: bool,
    insert_mode: bool,
    application_cursor: bool,
    bracketed_paste: bool,
    mouse_tracking: bool,
    mouse_sgr: bool,
    focus_events: bool,
    sync_output: bool,

    // Saved cursor
    saved_cursor: Option<SavedCursor>,

    // Alt screen saved state
    main_cells: Vec<Cell>,
    main_cursor: Option<SavedCursor>,

    // Title
    pub title: String,
    osc_buf: String,

    // Dirty flag — set when the screen has changed since last frame read
    dirty: bool,

    // Viewport scroll offset (0 = live bottom, >0 = scrolled up)
    viewport_offset: usize,

    // Tabstops
    tabstops: Vec<bool>,
}

#[derive(Clone)]
struct SavedCursor {
    x: usize,
    y: usize,
    fg: Color,
    bg: Color,
    attrs: CellAttrs,
    auto_wrap: bool,
}

impl ScreenBuffer {
    pub fn new(cols: usize, rows: usize, scrollback_limit: usize) -> Self {
        let mut tabstops = vec![false; cols];
        for i in (8..cols).step_by(8) {
            tabstops[i] = true;
        }

        Self {
            cols,
            rows,
            cells: vec![Cell::default(); cols * rows],
            scrollback: Vec::new(),
            scrollback_limit,
            cursor_x: 0,
            cursor_y: 0,
            cursor_visible: true,
            pen_fg: Color::Default,
            pen_bg: Color::Default,
            pen_attrs: CellAttrs::default(),
            scroll_top: 0,
            scroll_bottom: rows - 1,
            auto_wrap: true,
            wrap_pending: false,
            alternate_screen: false,
            origin_mode: false,
            insert_mode: false,
            application_cursor: false,
            bracketed_paste: false,
            mouse_tracking: false,
            mouse_sgr: false,
            focus_events: false,
            sync_output: false,
            saved_cursor: None,
            main_cells: Vec::new(),
            main_cursor: None,
            title: String::new(),
            osc_buf: String::new(),
            dirty: true,
            viewport_offset: 0,
            tabstops,
        }
    }

    // -----------------------------------------------------------------------
    // Cell access
    // -----------------------------------------------------------------------

    fn cell_mut(&mut self, row: usize, col: usize) -> &mut Cell {
        &mut self.cells[row * self.cols + col]
    }

    fn cell(&self, row: usize, col: usize) -> &Cell {
        &self.cells[row * self.cols + col]
    }

    // -----------------------------------------------------------------------
    // Scroll
    // -----------------------------------------------------------------------

    fn scroll_up(&mut self, top: usize, bottom: usize) {
        // Push top row to scrollback (only on main screen, full-width scroll)
        if !self.alternate_screen && top == 0 {
            let row: Vec<Cell> = (0..self.cols)
                .map(|c| self.cell(0, c).clone())
                .collect();
            self.scrollback.push(row);
            if self.scrollback.len() > self.scrollback_limit {
                self.scrollback.remove(0);
            }
        }

        // Shift rows up
        for r in top..bottom {
            for c in 0..self.cols {
                self.cells[r * self.cols + c] = self.cells[(r + 1) * self.cols + c].clone();
            }
        }

        // Clear bottom row
        for c in 0..self.cols {
            self.cells[bottom * self.cols + c] = Cell {
                bg: self.pen_bg,
                ..Cell::default()
            };
        }
        self.dirty = true;
    }

    fn scroll_down(&mut self, top: usize, bottom: usize) {
        for r in (top + 1..=bottom).rev() {
            for c in 0..self.cols {
                self.cells[r * self.cols + c] = self.cells[(r - 1) * self.cols + c].clone();
            }
        }
        for c in 0..self.cols {
            self.cells[top * self.cols + c] = Cell {
                bg: self.pen_bg,
                ..Cell::default()
            };
        }
        self.dirty = true;
    }

    // -----------------------------------------------------------------------
    // Erase
    // -----------------------------------------------------------------------

    fn erase_cell(&mut self, row: usize, col: usize) {
        self.cells[row * self.cols + col] = Cell {
            bg: self.pen_bg,
            ..Cell::default()
        };
    }

    fn erase_display(&mut self, mode: u16) {
        match mode {
            0 => {
                // Erase below (cursor to end)
                for c in self.cursor_x..self.cols {
                    self.erase_cell(self.cursor_y, c);
                }
                for r in (self.cursor_y + 1)..self.rows {
                    for c in 0..self.cols {
                        self.erase_cell(r, c);
                    }
                }
            }
            1 => {
                // Erase above (start to cursor)
                for r in 0..self.cursor_y {
                    for c in 0..self.cols {
                        self.erase_cell(r, c);
                    }
                }
                for c in 0..=self.cursor_x.min(self.cols - 1) {
                    self.erase_cell(self.cursor_y, c);
                }
            }
            2 => {
                // Erase entire screen
                for r in 0..self.rows {
                    for c in 0..self.cols {
                        self.erase_cell(r, c);
                    }
                }
            }
            3 => {
                // Erase screen + scrollback
                self.scrollback.clear();
                self.erase_display(2);
            }
            _ => {}
        }
        self.dirty = true;
    }

    fn erase_line(&mut self, mode: u16) {
        match mode {
            0 => {
                for c in self.cursor_x..self.cols {
                    self.erase_cell(self.cursor_y, c);
                }
            }
            1 => {
                for c in 0..=self.cursor_x.min(self.cols - 1) {
                    self.erase_cell(self.cursor_y, c);
                }
            }
            2 => {
                for c in 0..self.cols {
                    self.erase_cell(self.cursor_y, c);
                }
            }
            _ => {}
        }
        self.dirty = true;
    }

    // -----------------------------------------------------------------------
    // Cursor movement
    // -----------------------------------------------------------------------

    fn clamp_cursor(&mut self) {
        self.cursor_x = self.cursor_x.min(self.cols - 1);
        self.cursor_y = self.cursor_y.min(self.rows - 1);
    }

    // -----------------------------------------------------------------------
    // Index (newline within scroll region)
    // -----------------------------------------------------------------------

    fn index_down(&mut self) {
        if self.cursor_y == self.scroll_bottom {
            self.scroll_up(self.scroll_top, self.scroll_bottom);
        } else if self.cursor_y < self.rows - 1 {
            self.cursor_y += 1;
        }
    }

    fn reverse_index(&mut self) {
        if self.cursor_y == self.scroll_top {
            self.scroll_down(self.scroll_top, self.scroll_bottom);
        } else if self.cursor_y > 0 {
            self.cursor_y -= 1;
        }
    }

    // -----------------------------------------------------------------------
    // Alt screen
    // -----------------------------------------------------------------------

    fn switch_to_alt(&mut self) {
        if self.alternate_screen {
            return;
        }
        self.alternate_screen = true;
        self.main_cells = self.cells.clone();
        self.main_cursor = Some(SavedCursor {
            x: self.cursor_x,
            y: self.cursor_y,
            fg: self.pen_fg,
            bg: self.pen_bg,
            attrs: self.pen_attrs.clone(),
            auto_wrap: self.auto_wrap,
        });
        self.erase_display(2);
        self.dirty = true;
    }

    fn switch_to_main(&mut self) {
        if !self.alternate_screen {
            return;
        }
        self.alternate_screen = false;
        if !self.main_cells.is_empty() {
            self.cells = self.main_cells.clone();
            self.main_cells.clear();
        }
        if let Some(saved) = self.main_cursor.take() {
            self.cursor_x = saved.x;
            self.cursor_y = saved.y;
            self.pen_fg = saved.fg;
            self.pen_bg = saved.bg;
            self.pen_attrs = saved.attrs;
            self.auto_wrap = saved.auto_wrap;
        }
        self.dirty = true;
    }

    // -----------------------------------------------------------------------
    // Frame snapshot (sent to frontend)
    // -----------------------------------------------------------------------

    /// Take a snapshot of the visible screen for the frontend renderer.
    /// Returns None if the screen hasn't changed since the last snapshot.
    pub fn take_frame(&mut self) -> Option<ScreenFrame> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;

        let mut frame_cells;

        if self.viewport_offset > 0 && !self.alternate_screen {
            // Scrolled into scrollback — compose visible rows from
            // scrollback history + active screen.
            let sb_len = self.scrollback.len();
            let vp = self.viewport_offset;
            frame_cells = Vec::with_capacity(self.cols * self.rows);

            for row in 0..self.rows {
                let sb_row_idx = sb_len as i64 - vp as i64 + row as i64;
                if sb_row_idx >= 0 && (sb_row_idx as usize) < sb_len {
                    // This row comes from scrollback
                    let sb_row = &self.scrollback[sb_row_idx as usize];
                    for c in 0..self.cols {
                        if c < sb_row.len() {
                            frame_cells.push(sb_row[c].clone());
                        } else {
                            frame_cells.push(Cell::default());
                        }
                    }
                } else {
                    // This row comes from the active screen
                    let active_row = row as i64 - (vp as i64 - vp.min(sb_len) as i64);
                    if active_row >= 0 && (active_row as usize) < self.rows {
                        let ar = active_row as usize;
                        for c in 0..self.cols {
                            frame_cells.push(self.cells[ar * self.cols + c].clone());
                        }
                    } else {
                        for _ in 0..self.cols {
                            frame_cells.push(Cell::default());
                        }
                    }
                }
            }
        } else {
            frame_cells = self.cells.clone();
        }

        // Strip underline from all cells to prevent rendering artifacts.
        for cell in &mut frame_cells {
            cell.attrs.underline = 0;
        }

        Some(ScreenFrame {
            cols: self.cols,
            rows: self.rows,
            cells: frame_cells,
            cursor_x: self.cursor_x,
            cursor_y: self.cursor_y,
            cursor_visible: self.cursor_visible && self.viewport_offset == 0,
            title: self.title.clone(),
        })
    }

    /// Scroll the viewport. Positive = scroll up (into history), negative = scroll down.
    pub fn scroll_viewport(&mut self, delta: i32) {
        let max = self.scrollback.len();
        let new_offset = (self.viewport_offset as i32 + delta).max(0).min(max as i32) as usize;
        if new_offset != self.viewport_offset {
            self.viewport_offset = new_offset;
            self.dirty = true;
        }
    }

    /// Reset viewport to bottom (live view).
    pub fn reset_viewport(&mut self) {
        if self.viewport_offset != 0 {
            self.viewport_offset = 0;
            self.dirty = true;
        }
    }

    pub fn is_sync_output(&self) -> bool {
        self.sync_output
    }

    pub fn scrollback_length(&self) -> usize {
        self.scrollback.len()
    }

    /// Resize the terminal grid. Content is preserved where possible.
    pub fn resize(&mut self, new_cols: usize, new_rows: usize) {
        if new_cols == self.cols && new_rows == self.rows {
            return;
        }

        let mut new_cells = vec![Cell::default(); new_cols * new_rows];
        let copy_rows = self.rows.min(new_rows);
        let copy_cols = self.cols.min(new_cols);

        for r in 0..copy_rows {
            for c in 0..copy_cols {
                new_cells[r * new_cols + c] = self.cells[r * self.cols + c].clone();
            }
        }

        self.cells = new_cells;
        self.cols = new_cols;
        self.rows = new_rows;
        self.scroll_top = 0;
        self.scroll_bottom = new_rows - 1;
        self.cursor_x = self.cursor_x.min(new_cols - 1);
        self.cursor_y = self.cursor_y.min(new_rows - 1);

        // Rebuild tabstops
        self.tabstops = vec![false; new_cols];
        for i in (8..new_cols).step_by(8) {
            self.tabstops[i] = true;
        }

        self.dirty = true;
    }
}

// ---------------------------------------------------------------------------
// ScreenFrame — serialized for IPC to frontend
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ScreenFrame {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<Cell>,
    pub cursor_x: usize,
    pub cursor_y: usize,
    pub cursor_visible: bool,
    pub title: String,
}

// ---------------------------------------------------------------------------
// VTE Perform implementation — wires vte parser events to ScreenBuffer
// ---------------------------------------------------------------------------

impl Perform for ScreenBuffer {
    fn print(&mut self, c: char) {
        if self.wrap_pending {
            self.wrap_pending = false;
            self.cursor_x = 0;
            self.index_down();
        }

        if self.cursor_y >= self.rows || self.cursor_x >= self.cols {
            return;
        }

        let fg = self.pen_fg;
        let bg = self.pen_bg;
        let attrs = self.pen_attrs.clone();
        let idx = self.cursor_y * self.cols + self.cursor_x;
        self.cells[idx] = Cell {
            char: c.to_string(),
            fg,
            bg,
            attrs,
        };

        self.cursor_x += 1;
        if self.cursor_x >= self.cols {
            self.cursor_x = self.cols - 1;
            if self.auto_wrap {
                self.wrap_pending = true;
            }
        }

        self.dirty = true;
    }

    fn execute(&mut self, byte: u8) {
        self.wrap_pending = false;
        match byte {
            0x08 => {
                // BS — backspace
                if self.cursor_x > 0 {
                    self.cursor_x -= 1;
                }
            }
            0x09 => {
                // HT — horizontal tab
                let next = (self.cursor_x + 1..self.cols)
                    .find(|&c| self.tabstops.get(c).copied().unwrap_or(false))
                    .unwrap_or(self.cols - 1);
                self.cursor_x = next;
            }
            0x0a | 0x0b | 0x0c => {
                // LF, VT, FF — line feed
                self.index_down();
            }
            0x0d => {
                // CR — carriage return
                self.cursor_x = 0;
            }
            0x07 => {
                // BEL — bell (ignored)
            }
            _ => {}
        }
        self.dirty = true;
    }

    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        // DCS hook — not implemented yet
    }

    fn put(&mut self, _byte: u8) {
        // DCS put — not implemented yet
    }

    fn unhook(&mut self) {
        // DCS unhook — not implemented yet
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
        let _ = bell_terminated;
        if params.is_empty() {
            return;
        }

        // Parse the first param as the OSC number
        let osc_num = std::str::from_utf8(params[0])
            .ok()
            .and_then(|s| s.parse::<u16>().ok());

        match osc_num {
            Some(0) | Some(2) => {
                // Set window title
                if params.len() > 1 {
                    if let Ok(title) = std::str::from_utf8(params[1]) {
                        self.title = title.to_string();
                    }
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        // Collect params — preserve sub-parameter grouping for SGR handling.
        let ps: Vec<u16> = params.iter().flat_map(|sub| sub.iter().map(|&v| v)).collect();
        // Also keep raw param groups for SGR sub-parameter support (e.g. CSI 4:3 m)
        let raw_groups: Vec<Vec<u16>> = params.iter().map(|sub| sub.to_vec()).collect();
        let p0 = ps.first().copied().unwrap_or(0);
        let p1 = ps.get(1).copied().unwrap_or(0);
        let is_private = intermediates.first() == Some(&b'?');

        match action {
            // Cursor movement
            'A' => {
                // CUU — cursor up
                let n = (p0.max(1)) as usize;
                self.cursor_y = self.cursor_y.saturating_sub(n);
                self.wrap_pending = false;
            }
            'B' => {
                // CUD — cursor down
                let n = (p0.max(1)) as usize;
                self.cursor_y = (self.cursor_y + n).min(self.rows - 1);
                self.wrap_pending = false;
            }
            'C' => {
                // CUF — cursor forward
                let n = (p0.max(1)) as usize;
                self.cursor_x = (self.cursor_x + n).min(self.cols - 1);
                self.wrap_pending = false;
            }
            'D' => {
                // CUB — cursor backward
                let n = (p0.max(1)) as usize;
                self.cursor_x = self.cursor_x.saturating_sub(n);
                self.wrap_pending = false;
            }
            'E' => {
                // CNL — cursor next line
                let n = (p0.max(1)) as usize;
                self.cursor_x = 0;
                self.cursor_y = (self.cursor_y + n).min(self.rows - 1);
                self.wrap_pending = false;
            }
            'F' => {
                // CPL — cursor previous line
                let n = (p0.max(1)) as usize;
                self.cursor_x = 0;
                self.cursor_y = self.cursor_y.saturating_sub(n);
                self.wrap_pending = false;
            }
            'G' => {
                // CHA — cursor horizontal absolute
                self.cursor_x = ((p0.max(1)) as usize - 1).min(self.cols - 1);
                self.wrap_pending = false;
            }
            'H' | 'f' => {
                // CUP / HVP — cursor position
                let row = (p0.max(1)) as usize - 1;
                let col = (p1.max(1)) as usize - 1;
                self.cursor_y = row.min(self.rows - 1);
                self.cursor_x = col.min(self.cols - 1);
                self.wrap_pending = false;
            }
            'd' => {
                // VPA — vertical position absolute
                let row = (p0.max(1)) as usize - 1;
                self.cursor_y = row.min(self.rows - 1);
                self.wrap_pending = false;
            }

            // Erase
            'J' => self.erase_display(p0),
            'K' => self.erase_line(p0),
            'X' => {
                // ECH — erase characters
                let n = (p0.max(1)) as usize;
                for i in 0..n {
                    let c = self.cursor_x + i;
                    if c >= self.cols { break; }
                    self.erase_cell(self.cursor_y, c);
                }
                self.dirty = true;
            }

            // Insert/Delete
            'L' => {
                // IL — insert lines
                let n = (p0.max(1)) as usize;
                if self.cursor_y >= self.scroll_top && self.cursor_y <= self.scroll_bottom {
                    for _ in 0..n {
                        self.scroll_down(self.cursor_y, self.scroll_bottom);
                    }
                }
            }
            'M' => {
                // DL — delete lines
                let n = (p0.max(1)) as usize;
                if self.cursor_y >= self.scroll_top && self.cursor_y <= self.scroll_bottom {
                    for _ in 0..n {
                        self.scroll_up(self.cursor_y, self.scroll_bottom);
                    }
                }
            }
            'P' => {
                // DCH — delete characters
                let n = (p0.max(1) as usize).min(self.cols - self.cursor_x);
                let row = self.cursor_y;
                let col = self.cursor_x;
                for c in col..self.cols.saturating_sub(n) {
                    self.cells[row * self.cols + c] = self.cells[row * self.cols + c + n].clone();
                }
                for c in self.cols.saturating_sub(n)..self.cols {
                    self.erase_cell(row, c);
                }
                self.dirty = true;
            }
            '@' => {
                // ICH — insert characters
                let n = (p0.max(1)) as usize;
                let row = self.cursor_y;
                let col = self.cursor_x;
                for c in (col + n..self.cols).rev() {
                    self.cells[row * self.cols + c] = self.cells[row * self.cols + c - n].clone();
                }
                for c in col..(col + n).min(self.cols) {
                    self.erase_cell(row, c);
                }
                self.dirty = true;
            }

            // Scroll
            'S' => {
                // SU — scroll up
                let n = (p0.max(1)) as usize;
                for _ in 0..n {
                    self.scroll_up(self.scroll_top, self.scroll_bottom);
                }
            }
            'T' => {
                // SD — scroll down
                let n = (p0.max(1)) as usize;
                for _ in 0..n {
                    self.scroll_down(self.scroll_top, self.scroll_bottom);
                }
            }

            // Scroll region
            'r' => {
                if !is_private {
                    let top = if p0 > 0 { (p0 as usize) - 1 } else { 0 };
                    let bottom = if p1 > 0 {
                        ((p1 as usize) - 1).min(self.rows - 1)
                    } else {
                        self.rows - 1
                    };
                    if top < bottom {
                        self.scroll_top = top;
                        self.scroll_bottom = bottom;
                    } else {
                        self.scroll_top = 0;
                        self.scroll_bottom = self.rows - 1;
                    }
                    self.cursor_x = 0;
                    self.cursor_y = 0;
                    self.wrap_pending = false;
                }
            }

            // SGR — Select Graphic Rendition
            // Uses raw_groups to handle colon sub-parameters (e.g. CSI 4:3 m
            // for curly underline, CSI 38:2:R:G:B m for RGB color).
            'm' => {
                if raw_groups.is_empty() || (raw_groups.len() == 1 && raw_groups[0].first() == Some(&0)) {
                    self.pen_fg = Color::Default;
                    self.pen_bg = Color::Default;
                    self.pen_attrs = CellAttrs::default();
                    self.dirty = true;
                    return;
                }
                // SGR uses two forms for extended colors:
                // Colon form: CSI 38:5:N m → single group [38, 5, N]
                // Semicolon form: CSI 38;5;N m → three groups [38], [5], [N]
                // We handle both by first checking colon sub-params within
                // a group, then falling back to look-ahead across groups.
                let mut gi = 0;
                while gi < raw_groups.len() {
                    let group = &raw_groups[gi];
                    if group.is_empty() { gi += 1; continue; }
                    let code = group[0];
                    match code {
                        0 => {
                            self.pen_fg = Color::Default;
                            self.pen_bg = Color::Default;
                            self.pen_attrs = CellAttrs::default();
                        }
                        1 => self.pen_attrs.bold = true,
                        2 => self.pen_attrs.faint = true,
                        3 => self.pen_attrs.italic = true,
                        4 => {
                            // SGR 4 with optional sub-parameter: 4:0=none, 4:1=single,
                            // 4:2=double, 4:3=curly, 4:4=dotted, 4:5=dashed
                            let style = group.get(1).copied().unwrap_or(1);
                            self.pen_attrs.underline = style.min(5) as u8;
                        }
                        5 | 6 => self.pen_attrs.blink = true,
                        7 => self.pen_attrs.inverse = true,
                        8 => self.pen_attrs.hidden = true,
                        9 => self.pen_attrs.strikethrough = true,
                        21 => self.pen_attrs.underline = 2,    // double underline
                        22 => { self.pen_attrs.bold = false; self.pen_attrs.faint = false; }
                        23 => self.pen_attrs.italic = false,
                        24 => self.pen_attrs.underline = 0,
                        25 => self.pen_attrs.blink = false,
                        27 => self.pen_attrs.inverse = false,
                        28 => self.pen_attrs.hidden = false,
                        29 => self.pen_attrs.strikethrough = false,
                        53 => self.pen_attrs.overline = true,
                        55 => self.pen_attrs.overline = false,
                        30..=37 => self.pen_fg = Color::Palette { index: (code - 30) as u8 },
                        38 => {
                            if group.len() >= 3 && group[1] == 5 {
                                // Colon form: 38:5:N
                                self.pen_fg = Color::Palette { index: group[2] as u8 };
                            } else if group.len() >= 5 && group[1] == 2 {
                                // Colon form: 38:2:R:G:B
                                self.pen_fg = Color::Rgb {
                                    r: group[2] as u8,
                                    g: group[3] as u8,
                                    b: group[4] as u8,
                                };
                            } else if gi + 2 < raw_groups.len() {
                                // Semicolon form: look ahead
                                let sub = raw_groups[gi + 1].first().copied().unwrap_or(0);
                                if sub == 5 && gi + 2 < raw_groups.len() {
                                    let idx = raw_groups[gi + 2].first().copied().unwrap_or(0);
                                    self.pen_fg = Color::Palette { index: idx as u8 };
                                    gi += 2;
                                } else if sub == 2 && gi + 4 < raw_groups.len() {
                                    let r = raw_groups[gi + 2].first().copied().unwrap_or(0);
                                    let g = raw_groups[gi + 3].first().copied().unwrap_or(0);
                                    let b = raw_groups[gi + 4].first().copied().unwrap_or(0);
                                    self.pen_fg = Color::Rgb { r: r as u8, g: g as u8, b: b as u8 };
                                    gi += 4;
                                }
                            }
                        }
                        39 => self.pen_fg = Color::Default,
                        40..=47 => self.pen_bg = Color::Palette { index: (code - 40) as u8 },
                        48 => {
                            if group.len() >= 3 && group[1] == 5 {
                                self.pen_bg = Color::Palette { index: group[2] as u8 };
                            } else if group.len() >= 5 && group[1] == 2 {
                                self.pen_bg = Color::Rgb {
                                    r: group[2] as u8,
                                    g: group[3] as u8,
                                    b: group[4] as u8,
                                };
                            } else if gi + 2 < raw_groups.len() {
                                let sub = raw_groups[gi + 1].first().copied().unwrap_or(0);
                                if sub == 5 && gi + 2 < raw_groups.len() {
                                    let idx = raw_groups[gi + 2].first().copied().unwrap_or(0);
                                    self.pen_bg = Color::Palette { index: idx as u8 };
                                    gi += 2;
                                } else if sub == 2 && gi + 4 < raw_groups.len() {
                                    let r = raw_groups[gi + 2].first().copied().unwrap_or(0);
                                    let g = raw_groups[gi + 3].first().copied().unwrap_or(0);
                                    let b = raw_groups[gi + 4].first().copied().unwrap_or(0);
                                    self.pen_bg = Color::Rgb { r: r as u8, g: g as u8, b: b as u8 };
                                    gi += 4;
                                }
                            }
                        }
                        49 => self.pen_bg = Color::Default,
                        90..=97 => self.pen_fg = Color::Palette { index: (code - 90 + 8) as u8 },
                        100..=107 => self.pen_bg = Color::Palette { index: (code - 100 + 8) as u8 },
                        _ => {}
                    }
                    gi += 1;
                }
            }

            // DECSET / DECRST (private modes)
            'h' | 'l' => {
                let enable = action == 'h';
                if is_private {
                    for &mode in &ps {
                        match mode {
                            1 => self.application_cursor = enable,
                            7 => self.auto_wrap = enable,
                            12 => {} // cursor blink
                            25 => self.cursor_visible = enable,
                            47 | 1047 => {
                                if enable { self.switch_to_alt(); }
                                else { self.switch_to_main(); }
                            }
                            1000 | 1002 | 1003 => self.mouse_tracking = enable,
                            1004 => self.focus_events = enable,
                            1006 => self.mouse_sgr = enable,
                            1049 => {
                                if enable {
                                    self.saved_cursor = Some(SavedCursor {
                                        x: self.cursor_x,
                                        y: self.cursor_y,
                                        fg: self.pen_fg,
                                        bg: self.pen_bg,
                                        attrs: self.pen_attrs.clone(),
                                        auto_wrap: self.auto_wrap,
                                    });
                                    self.switch_to_alt();
                                } else {
                                    self.switch_to_main();
                                    if let Some(saved) = self.saved_cursor.take() {
                                        self.cursor_x = saved.x;
                                        self.cursor_y = saved.y;
                                        self.pen_fg = saved.fg;
                                        self.pen_bg = saved.bg;
                                        self.pen_attrs = saved.attrs;
                                        self.auto_wrap = saved.auto_wrap;
                                    }
                                }
                            }
                            2004 => self.bracketed_paste = enable,
                            2026 => self.sync_output = enable,
                            _ => {}
                        }
                    }
                }
            }

            // Device status / cursor position report
            'n' => {
                // We don't send responses from this module — handled by pty.rs
            }

            // Save/restore cursor
            's' => {
                if !is_private {
                    self.saved_cursor = Some(SavedCursor {
                        x: self.cursor_x,
                        y: self.cursor_y,
                        fg: self.pen_fg,
                        bg: self.pen_bg,
                        attrs: self.pen_attrs.clone(),
                        auto_wrap: self.auto_wrap,
                    });
                }
            }
            'u' => {
                if !is_private {
                    if let Some(saved) = self.saved_cursor.clone() {
                        self.cursor_x = saved.x.min(self.cols - 1);
                        self.cursor_y = saved.y.min(self.rows - 1);
                        self.pen_fg = saved.fg;
                        self.pen_bg = saved.bg;
                        self.pen_attrs = saved.attrs;
                        self.auto_wrap = saved.auto_wrap;
                    }
                }
            }

            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (intermediates, byte) {
            ([], b'7') => {
                // DECSC — save cursor
                self.saved_cursor = Some(SavedCursor {
                    x: self.cursor_x,
                    y: self.cursor_y,
                    fg: self.pen_fg,
                    bg: self.pen_bg,
                    attrs: self.pen_attrs.clone(),
                    auto_wrap: self.auto_wrap,
                });
            }
            ([], b'8') => {
                // DECRC — restore cursor
                if let Some(saved) = self.saved_cursor.clone() {
                    self.cursor_x = saved.x.min(self.cols - 1);
                    self.cursor_y = saved.y.min(self.rows - 1);
                    self.pen_fg = saved.fg;
                    self.pen_bg = saved.bg;
                    self.pen_attrs = saved.attrs;
                    self.auto_wrap = saved.auto_wrap;
                }
            }
            ([], b'D') => self.index_down(),      // IND — index
            ([], b'M') => self.reverse_index(),    // RI — reverse index
            ([], b'E') => {
                // NEL — next line
                self.cursor_x = 0;
                self.index_down();
            }
            ([], b'c') => {
                // RIS — full reset
                *self = ScreenBuffer::new(self.cols, self.rows, self.scrollback_limit);
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Thread-safe wrapper for use in Tauri state
// ---------------------------------------------------------------------------

pub type SharedScreen = Arc<Mutex<ScreenState>>;

pub struct ScreenState {
    pub screen: ScreenBuffer,
    pub parser: vte::Parser,
}

impl ScreenState {
    pub fn new(cols: usize, rows: usize, scrollback_limit: usize) -> Self {
        Self {
            screen: ScreenBuffer::new(cols, rows, scrollback_limit),
            parser: vte::Parser::new(),
        }
    }

    /// Feed raw PTY output bytes through the VT parser into the screen buffer.
    pub fn process(&mut self, data: &[u8]) {
        self.parser.advance(&mut self.screen, data);
    }
}
