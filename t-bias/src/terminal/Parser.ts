// ---------------------------------------------------------------------------
// VT / ANSI escape sequence parser
// ---------------------------------------------------------------------------
// A state-machine implementation following the Paul Williams VT500 parser
// model. Processes a stream of characters and dispatches semantic actions
// to a handler (the Screen).

export interface ParserHandler {
  /** Printable character */
  print(char: string): void;
  /** C0 control (BEL, BS, HT, LF, CR …) */
  execute(code: number): void;
  /** ESC sequence complete */
  escDispatch(intermediates: string, final: string): void;
  /** CSI sequence complete (params may contain sub-parameters via colon) */
  csiDispatch(params: number[], intermediates: string, final: string): void;
  /** OSC string complete */
  oscDispatch(data: string): void;
  /** DCS string complete (intermediates, params, data) */
  dcsDispatch?(intermediates: string, params: number[], data: string): void;
  /** APC string (consumed and dispatched) */
  apcDispatch?(data: string): void;
}

const enum S {
  Ground,
  Escape,
  EscapeIntermediate,
  CsiEntry,
  CsiParam,
  CsiIntermediate,
  CsiIgnore,
  OscString,
  OscEscape,              // saw ESC inside OSC, expecting '\'
  DcsEntry,               // DCS: collecting params
  DcsParam,
  DcsIntermediate,
  DcsPassthrough,          // DCS: collecting data payload
  DcsPassthroughEscape,    // saw ESC inside DCS passthrough
  ApcString,               // APC: collecting data
  ApcEscape,               // saw ESC inside APC
  PmString,                // PM: collecting (discarded)
  PmEscape,                // saw ESC inside PM
}

// Colon sub-parameter sentinel: when we encounter a colon inside CSI params,
// we push this marker so the handler can distinguish ; from : boundaries.
// Value chosen to never collide with real params (which are 0–65535 range).
export const SUB_PARAM_MARKER = -1;

// Grapheme segmenter — used to group combining marks, ZWJ sequences, etc.
// Falls back to codepoint-at-a-time if Intl.Segmenter is not available.
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export class Parser {
  private state: S = S.Ground;
  private params: number[] = [];
  private currentParam = -1;          // -1 = no digit seen for this param
  private intermediates = "";
  private oscData = "";
  private dcsData = "";
  private dcsIntermediates = "";
  private dcsParams: number[] = [];
  private apcData = "";

  // Ground-state print buffer for grapheme clustering
  private printBuf = "";

  constructor(private handler: ParserHandler) {}

  feed(data: string) {
    for (const ch of data) {                // iterates code-points, not code-units
      this.next(ch, ch.codePointAt(0)!);
    }
    // Flush any remaining print buffer at end of feed
    this.flushPrintBuffer();
  }

  /** Flush buffered printable characters, segmented into grapheme clusters. */
  private flushPrintBuffer() {
    if (this.printBuf.length === 0) return;
    const buf = this.printBuf;
    this.printBuf = "";

    if (segmenter) {
      for (const { segment } of segmenter.segment(buf)) {
        this.handler.print(segment);
      }
    } else {
      // Fallback: iterate codepoints (no grapheme clustering)
      for (const ch of buf) {
        this.handler.print(ch);
      }
    }
  }

  // -----------------------------------------------------------------------
  private next(ch: string, code: number) {
    // ESC is an "anywhere" transition (except inside string states)
    if (code === 0x1b) {
      switch (this.state) {
        case S.OscString:
          this.state = S.OscEscape;
          return;
        case S.DcsPassthrough:
          this.state = S.DcsPassthroughEscape;
          return;
        case S.ApcString:
          this.state = S.ApcEscape;
          return;
        case S.PmString:
          this.state = S.PmEscape;
          return;
        case S.OscEscape:
        case S.DcsPassthroughEscape:
        case S.ApcEscape:
        case S.PmEscape:
          // Double ESC inside string — treat as ESC within the string
          break;
        default:
          this.enterEscape();
          return;
      }
    }

    // CAN / SUB → abort current sequence
    if ((code === 0x18 || code === 0x1a) && this.state !== S.Ground) {
      this.state = S.Ground;
      return;
    }

    switch (this.state) {
      // ------- GROUND -------
      case S.Ground:
        if (code < 0x20 || code === 0x7f) {
          this.flushPrintBuffer();
          this.handler.execute(code);
        } else {
          // Buffer printable characters for grapheme cluster segmentation
          this.printBuf += ch;
        }
        break;

      // ------- ESCAPE -------
      case S.Escape:
        if (code === 0x5b) {            // [  → CSI
          this.enterCsi();
        } else if (code === 0x5d) {     // ]  → OSC
          this.enterOsc();
        } else if (code === 0x50) {     // P  → DCS
          this.enterDcs();
        } else if (code === 0x5f) {     // _  → APC
          this.enterApc();
        } else if (code === 0x5e) {     // ^  → PM (Privacy Message)
          this.enterPm();
        } else if (code >= 0x20 && code <= 0x2f) {
          this.intermediates += ch;
          this.state = S.EscapeIntermediate;
        } else if (code >= 0x30 && code <= 0x7e) {
          this.handler.escDispatch(this.intermediates, ch);
          this.state = S.Ground;
        } else if (code < 0x20) {
          this.handler.execute(code);
        }
        break;

      // ------- ESCAPE INTERMEDIATE -------
      case S.EscapeIntermediate:
        if (code >= 0x20 && code <= 0x2f) {
          this.intermediates += ch;
        } else if (code >= 0x30 && code <= 0x7e) {
          this.handler.escDispatch(this.intermediates, ch);
          this.state = S.Ground;
        } else if (code < 0x20) {
          this.handler.execute(code);
        }
        break;

      // ------- CSI ENTRY -------
      case S.CsiEntry:
        if (code >= 0x30 && code <= 0x39) {
          this.currentParam = code - 0x30;
          this.state = S.CsiParam;
        } else if (code === 0x3b) {     // ;
          this.pushParam();
          this.state = S.CsiParam;
        } else if (code === 0x3a) {     // : (colon sub-parameter)
          this.pushParam();
          this.params.push(SUB_PARAM_MARKER);
          this.state = S.CsiParam;
        } else if (code >= 0x3c && code <= 0x3f) {
          // < = > ?  → intermediate prefix
          this.intermediates += ch;
          this.state = S.CsiParam;
        } else if (code >= 0x20 && code <= 0x2f) {
          this.intermediates += ch;
          this.state = S.CsiIntermediate;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.pushParam();
          this.handler.csiDispatch(this.params, this.intermediates, ch);
          this.state = S.Ground;
        } else if (code < 0x20) {
          this.handler.execute(code);
        }
        break;

      // ------- CSI PARAM -------
      case S.CsiParam:
        if (code >= 0x30 && code <= 0x39) {
          if (this.currentParam < 0) this.currentParam = 0;
          this.currentParam = this.currentParam * 10 + (code - 0x30);
        } else if (code === 0x3b) {     // ;
          this.pushParam();
        } else if (code === 0x3a) {     // : (colon sub-parameter separator)
          this.pushParam();
          this.params.push(SUB_PARAM_MARKER);
        } else if (code >= 0x20 && code <= 0x2f) {
          this.pushParam();
          this.intermediates += ch;
          this.state = S.CsiIntermediate;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.pushParam();
          this.handler.csiDispatch(this.params, this.intermediates, ch);
          this.state = S.Ground;
        } else if (code >= 0x3c && code <= 0x3f) {
          // Unexpected intermediate in param state → ignore rest
          this.state = S.CsiIgnore;
        } else if (code < 0x20) {
          this.handler.execute(code);
        }
        break;

      // ------- CSI INTERMEDIATE -------
      case S.CsiIntermediate:
        if (code >= 0x20 && code <= 0x2f) {
          this.intermediates += ch;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.handler.csiDispatch(this.params, this.intermediates, ch);
          this.state = S.Ground;
        } else {
          this.state = S.CsiIgnore;
        }
        break;

      // ------- CSI IGNORE -------
      case S.CsiIgnore:
        if (code >= 0x40 && code <= 0x7e) {
          this.state = S.Ground;
        }
        break;

      // ------- OSC STRING -------
      case S.OscString:
        if (code === 0x07) {            // BEL terminates
          this.handler.oscDispatch(this.oscData);
          this.state = S.Ground;
        } else if (code >= 0x20) {
          this.oscData += ch;
        }
        break;

      case S.OscEscape:
        if (ch === "\\") {              // ST = ESC backslash
          this.handler.oscDispatch(this.oscData);
          this.state = S.Ground;
        } else {
          // False alarm — wasn't ST. The ESC starts a new escape.
          this.handler.oscDispatch(this.oscData);
          this.enterEscape();
          // Re-process this character in Escape state
          this.next(ch, code);
        }
        break;

      // ------- DCS (Device Control String) -------
      case S.DcsEntry:
        if (code >= 0x30 && code <= 0x39) {
          this.currentParam = code - 0x30;
          this.state = S.DcsParam;
        } else if (code === 0x3b) {
          this.pushDcsParam();
          this.state = S.DcsParam;
        } else if (code >= 0x20 && code <= 0x2f) {
          this.dcsIntermediates += ch;
          this.state = S.DcsIntermediate;
        } else if (code >= 0x40 && code <= 0x7e) {
          // Final character — enter passthrough mode
          this.dcsIntermediates += ch;
          this.state = S.DcsPassthrough;
        } else if (code >= 0x3c && code <= 0x3f) {
          this.dcsIntermediates += ch;
          this.state = S.DcsParam;
        }
        break;

      case S.DcsParam:
        if (code >= 0x30 && code <= 0x39) {
          if (this.currentParam < 0) this.currentParam = 0;
          this.currentParam = this.currentParam * 10 + (code - 0x30);
        } else if (code === 0x3b) {
          this.pushDcsParam();
        } else if (code >= 0x20 && code <= 0x2f) {
          this.pushDcsParam();
          this.dcsIntermediates += ch;
          this.state = S.DcsIntermediate;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.pushDcsParam();
          this.dcsData = ch; // final char is part of the DCS identity
          this.state = S.DcsPassthrough;
        }
        break;

      case S.DcsIntermediate:
        if (code >= 0x20 && code <= 0x2f) {
          this.dcsIntermediates += ch;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.dcsData = ch;
          this.state = S.DcsPassthrough;
        } else {
          // Invalid — skip to ST
          this.state = S.DcsPassthrough;
        }
        break;

      case S.DcsPassthrough:
        // Collect data until ST (ESC \)
        if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
          this.dcsData += ch;
        }
        // C0 controls (except those above) are ignored in passthrough
        break;

      case S.DcsPassthroughEscape:
        if (ch === "\\") {
          // ST — dispatch DCS
          this.handler.dcsDispatch?.(this.dcsIntermediates, this.dcsParams, this.dcsData);
          this.state = S.Ground;
        } else {
          // Not ST — the ESC was part of the data
          this.dcsData += "\x1b" + ch;
          this.state = S.DcsPassthrough;
        }
        break;

      // ------- APC (Application Program Command) -------
      case S.ApcString:
        if (code === 0x07) {
          // BEL terminates (like OSC)
          this.handler.apcDispatch?.(this.apcData);
          this.state = S.Ground;
        } else if (code >= 0x20) {
          this.apcData += ch;
        }
        break;

      case S.ApcEscape:
        if (ch === "\\") {
          this.handler.apcDispatch?.(this.apcData);
          this.state = S.Ground;
        } else {
          this.apcData += "\x1b" + ch;
          this.state = S.ApcString;
        }
        break;

      // ------- PM (Privacy Message) — consumed and discarded -------
      case S.PmString:
        if (code === 0x07) {
          this.state = S.Ground;
        }
        // Just consume characters
        break;

      case S.PmEscape:
        if (ch === "\\") {
          this.state = S.Ground;
        } else {
          this.state = S.PmString;
        }
        break;
    }
  }

  // -----------------------------------------------------------------------
  private enterEscape() {
    this.flushPrintBuffer();
    this.intermediates = "";
    this.state = S.Escape;
  }

  private enterCsi() {
    this.params = [];
    this.currentParam = -1;
    this.intermediates = "";
    this.state = S.CsiEntry;
  }

  private enterOsc() {
    this.oscData = "";
    this.state = S.OscString;
  }

  private enterDcs() {
    this.dcsIntermediates = "";
    this.dcsParams = [];
    this.dcsData = "";
    this.currentParam = -1;
    this.state = S.DcsEntry;
  }

  private enterApc() {
    this.apcData = "";
    this.state = S.ApcString;
  }

  private enterPm() {
    this.state = S.PmString;
  }

  private pushParam() {
    this.params.push(this.currentParam < 0 ? 0 : this.currentParam);
    this.currentParam = -1;
  }

  private pushDcsParam() {
    this.dcsParams.push(this.currentParam < 0 ? 0 : this.currentParam);
    this.currentParam = -1;
  }
}
