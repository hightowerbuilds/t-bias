export function keyboardEventToSequence(
  e: KeyboardEvent,
  applicationCursor: boolean
): string | null {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = e;

  // Ignore pure modifier presses
  if (
    key === "Control" ||
    key === "Alt" ||
    key === "Meta" ||
    key === "Shift"
  )
    return null;

  // Ctrl+key combinations
  if (ctrlKey && !altKey && !metaKey) {
    if (key.length === 1) {
      const upper = key.toUpperCase();
      const code = upper.charCodeAt(0);
      // Ctrl+A through Ctrl+Z → 0x01-0x1A
      if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
      // Ctrl+[ → ESC
      if (key === "[") return "\x1b";
      // Ctrl+\ → FS
      if (key === "\\") return "\x1c";
      // Ctrl+] → GS
      if (key === "]") return "\x1d";
      // Ctrl+^ → RS (Ctrl+6)
      if (key === "^" || key === "6") return "\x1e";
      // Ctrl+_ → US (Ctrl+-)
      if (key === "_" || key === "-") return "\x1f";
      // Ctrl+Space → NUL
      if (key === " ") return "\x00";
    }
  }

  // Special keys
  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return altKey ? "\x1b\x7f" : "\x7f";
    case "Tab":
      return shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      if (applicationCursor) return shiftKey ? "\x1b[1;2A" : "\x1bOA";
      return shiftKey ? "\x1b[1;2A" : "\x1b[A";
    case "ArrowDown":
      if (applicationCursor) return shiftKey ? "\x1b[1;2B" : "\x1bOB";
      return shiftKey ? "\x1b[1;2B" : "\x1b[B";
    case "ArrowRight":
      if (applicationCursor) return shiftKey ? "\x1b[1;2C" : "\x1bOC";
      return shiftKey ? "\x1b[1;2C" : "\x1b[C";
    case "ArrowLeft":
      if (applicationCursor) return shiftKey ? "\x1b[1;2D" : "\x1bOD";
      return shiftKey ? "\x1b[1;2D" : "\x1b[D";
    case "Home":
      return applicationCursor ? "\x1bOH" : "\x1b[H";
    case "End":
      return applicationCursor ? "\x1bOF" : "\x1b[F";
    case "Insert":
      return "\x1b[2~";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "F1":
      return "\x1bOP";
    case "F2":
      return "\x1bOQ";
    case "F3":
      return "\x1bOR";
    case "F4":
      return "\x1bOS";
    case "F5":
      return "\x1b[15~";
    case "F6":
      return "\x1b[17~";
    case "F7":
      return "\x1b[18~";
    case "F8":
      return "\x1b[19~";
    case "F9":
      return "\x1b[20~";
    case "F10":
      return "\x1b[21~";
    case "F11":
      return "\x1b[23~";
    case "F12":
      return "\x1b[24~";
  }

  // Alt+key → ESC prefix
  if (altKey && !ctrlKey && !metaKey && key.length === 1) {
    return "\x1b" + key;
  }

  // Regular printable characters
  if (key.length === 1 && !ctrlKey && !metaKey) {
    return key;
  }

  return null;
}
