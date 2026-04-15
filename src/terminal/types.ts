// ---------------------------------------------------------------------------
// Color representation
// ---------------------------------------------------------------------------
// Encoded as a single number for efficiency:
//   0              = default (theme-based)
//   1–256          = palette index (value - 1 = palette 0-255)
//   >= 0x1_000_000 = true color, lower 24 bits = 0xRRGGBB

export type Color = number;

export const DEFAULT_COLOR = 0;
const RGB_FLAG = 0x1_000_000;

export function paletteColor(index: number): Color {
  return index + 1;
}
export function rgbColor(r: number, g: number, b: number): Color {
  return RGB_FLAG | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
export function isDefault(c: Color): boolean {
  return c === 0;
}
export function isPalette(c: Color): boolean {
  return c > 0 && c < RGB_FLAG;
}
export function isRgb(c: Color): boolean {
  return c >= RGB_FLAG;
}
export function paletteIndex(c: Color): number {
  return c - 1;
}
export function rgbR(c: Color): number {
  return (c >> 16) & 0xff;
}
export function rgbG(c: Color): number {
  return (c >> 8) & 0xff;
}
export function rgbB(c: Color): number {
  return c & 0xff;
}

// ---------------------------------------------------------------------------
// Cell attributes (bitfield)
// ---------------------------------------------------------------------------
export const BOLD = 1 << 0;
export const FAINT = 1 << 1;
export const ITALIC = 1 << 2;
export const BLINK = 1 << 3;
export const INVERSE = 1 << 4;
export const HIDDEN = 1 << 5;
export const STRIKETHROUGH = 1 << 6;
export const OVERLINE = 1 << 7;
export const WIDE = 1 << 8;

// Underline style encoded in bits 9-11 (3 bits → values 0-7)
export const UL_SHIFT = 9;
export const UL_MASK = 0x7 << UL_SHIFT;
export const UL_NONE = 0;
export const UL_SINGLE = 1 << UL_SHIFT;
export const UL_DOUBLE = 2 << UL_SHIFT;
export const UL_CURLY = 3 << UL_SHIFT;
export const UL_DOTTED = 4 << UL_SHIFT;
export const UL_DASHED = 5 << UL_SHIFT;

export function ulStyle(attrs: number): number {
  return (attrs & UL_MASK) >> UL_SHIFT;
}

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------
export interface Cell {
  char: string;
  fg: Color;
  bg: Color;
  attrs: number;
  ulColor: Color;
}

export function blankCell(): Cell {
  return { char: "", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0, ulColor: DEFAULT_COLOR };
}

// ---------------------------------------------------------------------------
// 256-color palette (generates standard xterm palette)
// ---------------------------------------------------------------------------
const PALETTE_CACHE: [number, number, number][] = [];

export function palette256(index: number): [number, number, number] {
  if (PALETTE_CACHE.length === 0) buildPalette();
  return PALETTE_CACHE[index] ?? [0, 0, 0];
}

function buildPalette() {
  // 0-15: standard + bright (VGA-ish defaults)
  const base: [number, number, number][] = [
    [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
    [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
    [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
    [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
  ];
  for (const c of base) PALETTE_CACHE.push(c);

  // 16-231: 6×6×6 color cube
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        PALETTE_CACHE.push([levels[r], levels[g], levels[b]]);

  // 232-255: grayscale ramp
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    PALETTE_CACHE.push([v, v, v]);
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBg: string;
  // ANSI palette overrides (indexed 0-15)
  ansi: string[];
}

export const DEFAULT_THEME: Theme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBg: "#264f78",
  ansi: [
    "#1e1e1e", "#f44747", "#6a9955", "#d7ba7d",
    "#569cd6", "#c586c0", "#4ec9b0", "#d4d4d4",
    "#808080", "#f44747", "#6a9955", "#d7ba7d",
    "#569cd6", "#c586c0", "#4ec9b0", "#ffffff",
  ],
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface TerminalOptions {
  fontSize?: number;
  fontFamily?: string;
  theme?: Partial<Theme>;
  scrollbackLimit?: number;
}

// ---------------------------------------------------------------------------
// Wide character detection (Unicode East Asian Width)
// ---------------------------------------------------------------------------
export function isWideChar(char: string): boolean {
  const code = char.codePointAt(0)!;
  if (code < 0x1100) return false;
  // Hangul Jamo
  if (code >= 0x1100 && code <= 0x115f) return true;
  // CJK Radicals, Kangxi, Ideographic Description
  if (code >= 0x2e80 && code <= 0x303e) return true;
  // Katakana, Hangul Compat Jamo, Bopomofo, CJK Strokes, Enclosed CJK
  if (code >= 0x3041 && code <= 0x33bf) return true;
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  // CJK Unified Ideographs
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  // Yi, Hangul Syllables
  if (code >= 0xa000 && code <= 0xa4cf) return true;
  if (code >= 0xac00 && code <= 0xd7a3) return true;
  // CJK Compat Ideographs
  if (code >= 0xf900 && code <= 0xfaff) return true;
  // Fullwidth Forms
  if (code >= 0xfe10 && code <= 0xfe6f) return true;
  if (code >= 0xff01 && code <= 0xff60) return true;
  if (code >= 0xffe0 && code <= 0xffe6) return true;
  // Supplementary CJK
  if (code >= 0x1f300 && code <= 0x1f9ff) return true;
  if (code >= 0x20000 && code <= 0x2fa1f) return true;
  return false;
}
