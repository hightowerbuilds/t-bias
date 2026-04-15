// ---------------------------------------------------------------------------
// Tokenizer — simple regex-based syntax highlighting (no LSP, no npm deps)
// ---------------------------------------------------------------------------

export interface Token {
  start: number;
  length: number;
  type: TokenType;
}

export type TokenType =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "operator"
  | "punctuation"
  | "function"
  | "type"
  | "plain";

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

export function tokenColor(type: TokenType): string {
  switch (type) {
    case "keyword":     return "#569cd6";
    case "string":      return "#ce9178";
    case "comment":     return "#6a9955";
    case "number":      return "#b5cea8";
    case "operator":    return "#d4d4d4";
    case "punctuation": return "#d4d4d4";
    case "function":    return "#dcdcaa";
    case "type":        return "#4ec9b0";
    case "plain":       return "#d4d4d4";
  }
}

// ---------------------------------------------------------------------------
// Language rules
// ---------------------------------------------------------------------------

interface TokenRule {
  pattern: RegExp;
  type: TokenType;
}

const TS_KEYWORDS = [
  "abstract", "as", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "from",
  "function", "get", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "of", "package", "private",
  "protected", "public", "readonly", "return", "set", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "var", "void", "while", "with", "yield",
];

const RS_KEYWORDS = [
  "as", "async", "await", "break", "const", "continue", "crate", "dyn",
  "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
  "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
  "self", "Self", "static", "struct", "super", "trait", "true", "type",
  "unsafe", "use", "where", "while",
];

const TS_TYPES = [
  "any", "boolean", "never", "number", "object", "string", "symbol",
  "unknown", "bigint",
];

const RS_TYPES = [
  "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128",
  "isize", "str", "u8", "u16", "u32", "u64", "u128", "usize",
  "String", "Vec", "Option", "Result", "Box", "Rc", "Arc",
];

function buildRules(keywords: string[], types: string[]): TokenRule[] {
  const kwPattern = new RegExp(`\\b(?:${keywords.join("|")})\\b`);
  const typePattern = new RegExp(`\\b(?:${types.join("|")})\\b`);

  return [
    { pattern: /\/\/.*/, type: "comment" },
    { pattern: /\/\*[\s\S]*?\*\//, type: "comment" },
    { pattern: /"(?:[^"\\]|\\.)*"/, type: "string" },
    { pattern: /'(?:[^'\\]|\\.)*'/, type: "string" },
    { pattern: /`(?:[^`\\]|\\.)*`/, type: "string" },
    { pattern: typePattern, type: "type" },
    { pattern: kwPattern, type: "keyword" },
    { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, type: "number" },
    { pattern: /0x[0-9a-fA-F]+/, type: "number" },
    { pattern: /0b[01]+/, type: "number" },
    { pattern: /\b[a-zA-Z_]\w*(?=\s*\()/, type: "function" },
    { pattern: /[{}()\[\];,.]/, type: "punctuation" },
    { pattern: /[+\-*/%=<>!&|^~?:]+/, type: "operator" },
  ];
}

const tsRules = buildRules(TS_KEYWORDS, TS_TYPES);
const rsRules = buildRules(RS_KEYWORDS, RS_TYPES);

function rulesForExt(ext: string): TokenRule[] {
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs":
      return tsRules;
    case "rs":
      return rsRules;
    default:
      return tsRules; // fallback
  }
}

// ---------------------------------------------------------------------------
// Tokenize a single line
// ---------------------------------------------------------------------------

export function tokenizeLine(line: string, ext: string): Token[] {
  const rules = rulesForExt(ext);
  const tokens: Token[] = [];
  let pos = 0;

  // Build a combined regex from all rules
  const combined = new RegExp(
    rules.map((r, i) => `(${r.pattern.source})`).join("|"),
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = combined.exec(line)) !== null) {
    // Fill gap with plain tokens
    if (match.index > pos) {
      tokens.push({ start: pos, length: match.index - pos, type: "plain" });
    }

    // Find which group matched
    let type: TokenType = "plain";
    for (let i = 0; i < rules.length; i++) {
      if (match[i + 1] !== undefined) {
        type = rules[i].type;
        break;
      }
    }

    tokens.push({ start: match.index, length: match[0].length, type });
    pos = match.index + match[0].length;
  }

  // Trailing plain text
  if (pos < line.length) {
    tokens.push({ start: pos, length: line.length - pos, type: "plain" });
  }

  return tokens;
}
