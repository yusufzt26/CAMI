/** Tokenizer for word-address G-code. Port of backend app/gcode/lexer.py. */

export class Word {
  constructor(
    readonly letter: string,
    readonly value: number,
    readonly raw: string,
  ) {}
  get hasDecimalPoint(): boolean {
    return this.raw.includes(".");
  }
  /** Normalised code key for G/M words, e.g. G00 -> 'G0', G05.1 -> 'G5.1'. */
  get code(): string {
    return Number.isInteger(this.value) ? `${this.letter}${this.value}` : `${this.letter}${fmtG(this.value)}`;
  }
}

export class Block {
  words: Word[] = [];
  comment: string | null = null;
  blockDelete = false;
  sequence: number | null = null;
  programNumber: string | null = null;
  lexErrors: string[] = [];
  macro = false;
  constructor(
    readonly index: number,
    readonly line: number,
    readonly text: string,
  ) {}
  get(letter: string): Word | undefined {
    return this.words.find((w) => w.letter === letter);
  }
  has(letter: string): boolean {
    return this.words.some((w) => w.letter === letter);
  }
}

/** Python "{:g}" formatting. */
export function fmtG(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  return String(Number(v.toPrecision(6)));
}

const WORD_RE = /([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
const MACRO_RE = /#|\[|\]|=|\b(IF|GOTO|WHILE|DO|END|THEN|EQ|NE|GT|LT|GE|LE)\b/;

function stripComments(line: string): [string, string | null, string | null] {
  let out = "";
  const comments: string[] = [];
  let error: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "(") {
      const end = line.indexOf(")", i + 1);
      if (end === -1) {
        comments.push(line.slice(i + 1).trim());
        error = "Unclosed '(' comment";
        break;
      }
      comments.push(line.slice(i + 1, end).trim());
      i = end + 1;
      continue;
    }
    if (ch === ";") {
      comments.push(line.slice(i + 1).trim());
      break;
    }
    out += ch;
    i++;
  }
  const comment = comments.filter((c) => c).join(" ") || null;
  return [out, comment, error];
}

export function tokenize(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const stripped = rawLine.trim();
    if (!stripped) return;
    let [code, comment, err] = stripComments(stripped);
    code = code.trim().toUpperCase();
    const block = new Block(blocks.length, lineNo, stripped);
    block.comment = comment;
    if (err) block.lexErrors.push(err);

    if (code.startsWith("%")) {
      code = code.slice(1).trim();
      if (!code) {
        if (comment) blocks.push(block);
        return;
      }
    }
    if (code.startsWith("/")) {
      block.blockDelete = true;
      code = code.slice(1).trimStart();
    }
    if (MACRO_RE.test(code)) {
      block.macro = true;
      blocks.push(block);
      return;
    }
    const m = /^[O:]\s*(\d+)/.exec(code);
    if (m) {
      block.programNumber = m[1];
      code = code.slice(m[0].length);
    }
    let pos = 0;
    const leftovers: string[] = [];
    WORD_RE.lastIndex = 0;
    let wm: RegExpExecArray | null;
    while ((wm = WORD_RE.exec(code))) {
      const gap = code.slice(pos, wm.index);
      if (gap.trim()) leftovers.push(gap.trim());
      const letter = wm[1];
      const num = wm[2];
      if (letter === "N" && block.sequence === null && block.words.length === 0) {
        block.sequence = Math.trunc(parseFloat(num));
      } else {
        block.words.push(new Word(letter, parseFloat(num), num));
      }
      pos = wm.index + wm[0].length;
    }
    const tail = code.slice(pos);
    if (tail.trim()) leftovers.push(tail.trim());
    for (const bad of leftovers) block.lexErrors.push(`Unrecognised text '${bad}'`);
    if (block.words.length || block.comment || block.lexErrors.length || block.programNumber) blocks.push(block);
  });
  return blocks;
}
