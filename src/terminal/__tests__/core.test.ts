import { describe, it, expect } from "vitest";
import { TerminalCore } from "../TerminalCore";
import { rgbColor, paletteColor, DEFAULT_COLOR } from "../types";

// Helper: create a core and write data, return the core for assertions
function term(cols = 80, rows = 24): TerminalCore {
  return new TerminalCore(cols, rows, 100);
}

function cellAt(core: TerminalCore, row: number, col: number) {
  return core.getRenderState().getCell(row, col);
}

function textAt(core: TerminalCore, row: number, startCol = 0, endCol?: number): string {
  const end = endCol ?? core.cols - 1;
  let text = "";
  for (let c = startCol; c <= end; c++) {
    text += core.getRenderState().getCell(row, c).char || " ";
  }
  return text.trimEnd();
}

// =========================================================================
// Cursor movement
// =========================================================================
describe("Cursor movement", () => {
  it("CUP moves cursor to specified position", () => {
    const c = term();
    c.write("\x1b[5;10H");
    expect(c.cursor.x).toBe(9);  // 0-indexed
    expect(c.cursor.y).toBe(4);
  });

  it("CUP defaults to 1;1 (home)", () => {
    const c = term();
    c.write("hello\x1b[H");
    expect(c.cursor.x).toBe(0);
    expect(c.cursor.y).toBe(0);
  });

  it("CUU moves cursor up", () => {
    const c = term();
    c.write("\x1b[5;5H\x1b[2A");
    expect(c.cursor.y).toBe(2);
    expect(c.cursor.x).toBe(4);
  });

  it("CUD moves cursor down", () => {
    const c = term();
    c.write("\x1b[5;5H\x1b[3B");
    expect(c.cursor.y).toBe(7);
  });

  it("CUF moves cursor right", () => {
    const c = term();
    c.write("\x1b[1;1H\x1b[5C");
    expect(c.cursor.x).toBe(5);
  });

  it("CUB moves cursor left", () => {
    const c = term();
    c.write("\x1b[1;10H\x1b[3D");
    expect(c.cursor.x).toBe(6);
  });

  it("CHA sets column", () => {
    const c = term();
    c.write("\x1b[5;10H\x1b[20G");
    expect(c.cursor.x).toBe(19);
    expect(c.cursor.y).toBe(4); // row unchanged
  });

  it("VPA sets row", () => {
    const c = term();
    c.write("\x1b[5;10H\x1b[15d");
    expect(c.cursor.y).toBe(14);
    expect(c.cursor.x).toBe(9); // col unchanged
  });
});

// =========================================================================
// Text output
// =========================================================================
describe("Text output", () => {
  it("prints ASCII characters at cursor position", () => {
    const c = term();
    c.write("Hello");
    expect(textAt(c, 0, 0, 4)).toBe("Hello");
    expect(c.cursor.x).toBe(5);
  });

  it("wraps at end of line", () => {
    const c = term(10, 5);
    c.write("0123456789X");
    expect(textAt(c, 0, 0, 9)).toBe("0123456789");
    expect(cellAt(c, 1, 0).char).toBe("X");
  });

  it("handles carriage return + line feed", () => {
    const c = term();
    c.write("line1\r\nline2");
    expect(textAt(c, 0, 0, 4)).toBe("line1");
    expect(textAt(c, 1, 0, 4)).toBe("line2");
  });

  it("handles backspace", () => {
    const c = term();
    c.write("AB\x08C");
    // A at 0, B at 1, BS moves to 1, C overwrites B at 1
    expect(cellAt(c, 0, 0).char).toBe("A");
    expect(cellAt(c, 0, 1).char).toBe("C");
    expect(c.cursor.x).toBe(2);
  });
});

// =========================================================================
// Erase operations
// =========================================================================
describe("Erase operations", () => {
  it("ED 2 clears the entire screen", () => {
    const c = term(10, 5);
    c.write("AAAAAAAAAA\r\nBBBBBBBBBB");
    c.write("\x1b[2J");
    expect(textAt(c, 0, 0, 9)).toBe("");
    expect(textAt(c, 1, 0, 9)).toBe("");
  });

  it("EL 0 clears from cursor to end of line", () => {
    const c = term(10, 5);
    c.write("0123456789\x1b[1;4H\x1b[K");
    expect(textAt(c, 0, 0, 9)).toBe("012");
  });

  it("EL 1 clears from start of line to cursor (inclusive)", () => {
    const c = term(10, 5);
    c.write("0123456789\x1b[1;4H\x1b[1K");
    // EL 1 clears cols 0 through cursor (col 3 inclusive)
    expect(textAt(c, 0, 0, 9)).toBe("    456789");
  });

  it("ECH erases N characters at cursor", () => {
    const c = term(10, 5);
    c.write("0123456789\x1b[1;4H\x1b[3X");
    expect(textAt(c, 0, 0, 9)).toBe("012   6789");
  });
});

// =========================================================================
// SGR (Select Graphic Rendition)
// =========================================================================
describe("SGR", () => {
  it("38;2;R;G;B sets true color foreground (semicolon form)", () => {
    const c = term();
    c.write("\x1b[38;2;255;128;0mX");
    const cell = cellAt(c, 0, 0);
    expect(cell.fg).toBe(rgbColor(255, 128, 0));
  });

  it("38:2:R:G:B sets true color foreground (colon form)", () => {
    const c = term();
    c.write("\x1b[38:2:100:200:50mX");
    const cell = cellAt(c, 0, 0);
    expect(cell.fg).toBe(rgbColor(100, 200, 50));
  });

  it("38;5;N sets 256-color foreground", () => {
    const c = term();
    c.write("\x1b[38;5;196mX");
    const cell = cellAt(c, 0, 0);
    expect(cell.fg).toBe(paletteColor(196));
  });

  it("SGR 0 resets all attributes", () => {
    const c = term();
    c.write("\x1b[1;31mA\x1b[0mB");
    const a = cellAt(c, 0, 0);
    const b = cellAt(c, 0, 1);
    expect(a.fg).not.toBe(DEFAULT_COLOR);
    expect(b.fg).toBe(DEFAULT_COLOR);
    expect(b.attrs).toBe(0);
  });

  it("4:3 sets curly underline via colon sub-param", () => {
    const c = term();
    c.write("\x1b[4:3mX");
    const cell = cellAt(c, 0, 0);
    // UL_CURLY = 3 << 9 = 1536
    expect((cell.attrs >> 9) & 0x7).toBe(3);
  });
});

// =========================================================================
// Scroll regions
// =========================================================================
describe("Scroll regions", () => {
  it("DECSTBM sets scroll region", () => {
    const c = term(10, 10);
    c.write("\x1b[3;7r"); // rows 3-7
    // Cursor moves to home
    expect(c.cursor.x).toBe(0);
    expect(c.cursor.y).toBe(0);
  });

  it("content scrolls within the region", () => {
    const c = term(10, 5);
    c.write("\x1b[2;4r");     // scroll region rows 2-4
    c.write("\x1b[2;1H");     // move to row 2
    c.write("A\r\nB\r\nC\r\nD"); // D should cause scroll within region
    expect(textAt(c, 1, 0, 0)).toBe("B");
    expect(textAt(c, 2, 0, 0)).toBe("C");
    expect(textAt(c, 3, 0, 0)).toBe("D");
  });
});

// =========================================================================
// Tab stops
// =========================================================================
describe("Tab stops", () => {
  it("horizontal tab moves to next tab stop", () => {
    const c = term();
    c.write("\t");
    expect(c.cursor.x).toBe(8);
  });

  it("HTS sets a tab stop at cursor", () => {
    const c = term();
    c.write("\x1b[5G\x1bH"); // Move to col 5, set tab stop
    c.write("\x1b[1G\t");     // Go home, tab forward
    expect(c.cursor.x).toBe(4); // 0-indexed col 4 (column 5)
  });

  it("TBC 0 clears tab at cursor position", () => {
    const c = term();
    // Col 9 in 1-based = col 8 in 0-based. Tab stop at col 8 exists.
    c.write("\x1b[9G\x1b[0g"); // Move to 0-indexed col 8, clear tab there
    c.write("\x1b[1G\t");       // Tab should now skip col 8 and go to 16
    expect(c.cursor.x).toBe(16);
  });

  it("TBC 3 clears all tab stops", () => {
    const c = term();
    c.write("\x1b[3g");  // Clear all
    c.write("\t");         // Should go to end of line
    expect(c.cursor.x).toBe(79);
  });

  it("CBT moves backward through tab stops", () => {
    const c = term();
    c.write("\x1b[20G\x1b[Z"); // col 20 (0-indexed=19), backward tab
    expect(c.cursor.x).toBe(16); // Previous tab stop at col 16
  });
});

// =========================================================================
// Character sets
// =========================================================================
describe("Character sets", () => {
  it("DEC Special Graphics maps line-drawing characters", () => {
    const c = term();
    c.write("\x1b(0");   // Designate G0 as DEC Special Graphics
    c.write("q");         // horizontal line
    expect(cellAt(c, 0, 0).char).toBe("\u2500"); // ─

    c.write("x");         // vertical line
    expect(cellAt(c, 0, 1).char).toBe("\u2502"); // │
  });

  it("ESC ( B restores ASCII", () => {
    const c = term();
    c.write("\x1b(0q\x1b(Bq");
    expect(cellAt(c, 0, 0).char).toBe("\u2500"); // line drawing
    expect(cellAt(c, 0, 1).char).toBe("q");       // ASCII
  });

  it("SO/SI switches between G0 and G1", () => {
    const c = term();
    c.write("\x1b)0");    // Designate G1 as DEC Special Graphics
    c.write("\x0E");       // SO → switch to G1
    c.write("l");          // upper-left corner
    expect(cellAt(c, 0, 0).char).toBe("\u250C"); // ┌
    c.write("\x0F");       // SI → switch back to G0
    c.write("l");
    expect(cellAt(c, 0, 1).char).toBe("l"); // plain ASCII
  });
});

// =========================================================================
// Alt screen
// =========================================================================
describe("Alt screen", () => {
  it("mode 1049 switches to alt screen and back", () => {
    const c = term(10, 5);
    c.write("MAIN");
    expect(c.modes.isAlternateScreen).toBe(false);
    c.write("\x1b[?1049h");  // Enter alt screen
    expect(c.modes.isAlternateScreen).toBe(true);
    // Move to home and write on alt screen
    c.write("\x1b[H" + "ALT");
    expect(c.cursor.x).toBe(3);
    c.write("\x1b[?1049l");  // Leave alt screen
    expect(c.modes.isAlternateScreen).toBe(false);
    // Main buffer should be restored
    expect(textAt(c, 0, 0, 3)).toBe("MAIN");
  });
});

// =========================================================================
// Modes
// =========================================================================
describe("Modes", () => {
  it("bracketed paste mode", () => {
    const c = term();
    expect(c.modes.bracketedPaste).toBe(false);
    c.write("\x1b[?2004h");
    expect(c.modes.bracketedPaste).toBe(true);
    c.write("\x1b[?2004l");
    expect(c.modes.bracketedPaste).toBe(false);
  });

  it("focus events mode", () => {
    const c = term();
    expect(c.modes.focusEvents).toBe(false);
    c.write("\x1b[?1004h");
    expect(c.modes.focusEvents).toBe(true);
  });

  it("application cursor mode", () => {
    const c = term();
    expect(c.modes.applicationCursor).toBe(false);
    c.write("\x1b[?1h");
    expect(c.modes.applicationCursor).toBe(true);
  });
});

// =========================================================================
// Device status / response
// =========================================================================
describe("Device responses", () => {
  it("DA1 sends response", () => {
    const c = term();
    let response = "";
    c.onResponse = (data) => { response = data; };
    c.write("\x1b[c");
    expect(response).toContain("\x1b[?");
  });

  it("DSR 6 reports cursor position", () => {
    const c = term();
    let response = "";
    c.onResponse = (data) => { response = data; };
    c.write("\x1b[5;10H\x1b[6n");
    expect(response).toBe("\x1b[5;10R");
  });
});

// =========================================================================
// DECSTR (soft reset)
// =========================================================================
describe("DECSTR", () => {
  it("resets attributes without clearing screen", () => {
    const c = term();
    c.write("\x1b[1;31mHello"); // bold + red
    c.write("\x1b[!p");         // soft reset
    c.write("World");
    const h = cellAt(c, 0, 0);
    const w = cellAt(c, 0, 5);
    expect(h.attrs).not.toBe(0); // Hello retains attrs
    expect(w.attrs).toBe(0);     // World has reset attrs
    expect(w.fg).toBe(DEFAULT_COLOR);
  });
});

// =========================================================================
// Insert / Delete
// =========================================================================
describe("Insert and delete", () => {
  it("ICH inserts blank characters", () => {
    const c = term(10, 5);
    c.write("ABCDE\x1b[1;3H\x1b[2@");
    expect(textAt(c, 0, 0, 6)).toBe("AB  CDE");
  });

  it("DCH deletes characters", () => {
    const c = term(10, 5);
    c.write("ABCDE\x1b[1;3H\x1b[2P");
    // Delete 2 chars at col 2: removes C and D, E slides left
    expect(textAt(c, 0, 0, 4)).toBe("ABE");
  });

  it("IL inserts lines", () => {
    const c = term(10, 5);
    c.write("AAA\r\nBBB\r\nCCC");
    c.write("\x1b[2;1H\x1b[1L");
    expect(textAt(c, 0, 0, 2)).toBe("AAA");
    expect(textAt(c, 1, 0, 2)).toBe("");
    expect(textAt(c, 2, 0, 2)).toBe("BBB");
  });

  it("DL deletes lines", () => {
    const c = term(10, 5);
    c.write("AAA\r\nBBB\r\nCCC");
    c.write("\x1b[2;1H\x1b[1M");
    expect(textAt(c, 0, 0, 2)).toBe("AAA");
    expect(textAt(c, 1, 0, 2)).toBe("CCC");
  });
});

// =========================================================================
// TUI simulation: typed array consistency
// =========================================================================
describe("TUI typed array consistency", () => {
  /** Read char from typed arrays directly (bypasses getCell). */
  function vcCharAt(core: TerminalCore, row: number, col: number): string {
    const vc = core.virtualCanvas;
    const idx = vc.rowOffset(row) + col;
    const cp = vc.activeChars[idx];
    if (cp === 0) return "";
    if (cp === 0xFFFFFFFF) return vc.getGraphemeByIndex(idx) ?? "";
    return String.fromCodePoint(cp);
  }

  /** Read a row of text from typed arrays directly. */
  function vcTextRow(core: TerminalCore, row: number): string {
    let text = "";
    for (let c = 0; c < core.cols; c++) {
      text += vcCharAt(core, row, c) || " ";
    }
    return text.trimEnd();
  }

  it("sequential lines land on correct rows", () => {
    const c = term(20, 10);
    c.write("line0\r\nline1\r\nline2\r\nline3\r\nline4");
    // Check via getCell
    expect(textAt(c, 0, 0, 4)).toBe("line0");
    expect(textAt(c, 1, 0, 4)).toBe("line1");
    expect(textAt(c, 2, 0, 4)).toBe("line2");
    expect(textAt(c, 3, 0, 4)).toBe("line3");
    expect(textAt(c, 4, 0, 4)).toBe("line4");
    // Check typed arrays directly
    expect(vcTextRow(c, 0)).toBe("line0");
    expect(vcTextRow(c, 1)).toBe("line1");
    expect(vcTextRow(c, 2)).toBe("line2");
    expect(vcTextRow(c, 3)).toBe("line3");
    expect(vcTextRow(c, 4)).toBe("line4");
    // Rows 5-9 should be blank
    for (let r = 5; r < 10; r++) {
      expect(vcTextRow(c, r)).toBe("");
    }
  });

  it("alt screen + scroll region works correctly", () => {
    const c = term(20, 10);
    // Enter alt screen (mode 1049)
    c.write("\x1b[?1049h");
    // Set scroll region to rows 2-8 (1-based: 3-9)
    c.write("\x1b[3;9r");
    // Write text at each row in the scroll region
    for (let r = 2; r <= 8; r++) {
      c.write(`\x1b[${r + 1};1Hrow${r}`);
    }
    expect(vcTextRow(c, 2)).toBe("row2");
    expect(vcTextRow(c, 5)).toBe("row5");
    expect(vcTextRow(c, 8)).toBe("row8");
    // Now scroll the region up (CSI S)
    c.write("\x1b[1S");
    // row2 content should be gone, row3->row2, etc.
    expect(vcTextRow(c, 2)).toBe("row3");
    expect(vcTextRow(c, 7)).toBe("row8");
    expect(vcTextRow(c, 8)).toBe(""); // blank from scroll
  });

  it("scroll by writing at bottom of region", () => {
    const c = term(20, 5);
    // Fill all 5 rows
    c.write("row0\r\nrow1\r\nrow2\r\nrow3\r\nrow4");
    expect(c.cursor.y).toBe(4);
    expect(vcTextRow(c, 4)).toBe("row4");
    // Write another line — should scroll
    c.write("\r\nnew5");
    // row0 should have scrolled off, everything shifts up
    expect(vcTextRow(c, 0)).toBe("row1");
    expect(vcTextRow(c, 1)).toBe("row2");
    expect(vcTextRow(c, 2)).toBe("row3");
    expect(vcTextRow(c, 3)).toBe("row4");
    expect(vcTextRow(c, 4)).toBe("new5");
  });

  it("insertLines shifts typed array data correctly", () => {
    const c = term(10, 5);
    c.write("AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE");
    // Position at row 1 (0-based) and insert a line
    c.write("\x1b[2;1H\x1b[1L");
    expect(vcTextRow(c, 0)).toBe("AAA");
    expect(vcTextRow(c, 1)).toBe(""); // inserted blank
    expect(vcTextRow(c, 2)).toBe("BBB");
    expect(vcTextRow(c, 3)).toBe("CCC");
    expect(vcTextRow(c, 4)).toBe("DDD");
    // EEE fell off the bottom
  });

  it("getCell and typed arrays agree", () => {
    const c = term(20, 5);
    c.write("\x1b[?1049h"); // alt screen
    c.write("\x1b[2;5HHello World");
    // Both paths should return the same data
    for (let col = 4; col < 15; col++) {
      const cell = cellAt(c, 1, col);
      const vcChar = vcCharAt(c, 1, col);
      expect(vcChar).toBe(cell.char);
    }
  });

  it("rapid cursor positioning writes to correct typed array positions", () => {
    const c = term(20, 10);
    // Simulate TUI: jump around and write
    c.write("\x1b[1;1Hcorner");
    c.write("\x1b[5;10Hmiddle");
    c.write("\x1b[10;1Hbottom");
    expect(vcTextRow(c, 0)).toBe("corner");
    expect(vcTextRow(c, 4).slice(9)).toBe("middle");
    expect(vcTextRow(c, 9)).toBe("bottom");
    // Rows without writes should be blank
    expect(vcTextRow(c, 1)).toBe("");
    expect(vcTextRow(c, 2)).toBe("");
    expect(vcTextRow(c, 3)).toBe("");
  });
});
