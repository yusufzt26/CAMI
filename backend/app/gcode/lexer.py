"""Tokenizer for word-address G-code (FANUC style).

The lexer is controller-neutral: it turns raw text into blocks of address
words and records anything it cannot understand as a lexical problem. It never
drops content silently; the interpreter decides what each problem means for
machining safety.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_WORD_RE = re.compile(r"([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))")
# Tokens that indicate custom macro B / control-flow syntax.
_MACRO_RE = re.compile(r"#|\[|\]|=|\b(IF|GOTO|WHILE|DO|END|THEN|EQ|NE|GT|LT|GE|LE)\b")


@dataclass
class Word:
    letter: str
    value: float
    raw: str  # numeric text exactly as written, e.g. "10" or "10.000"

    @property
    def has_decimal_point(self) -> bool:
        return "." in self.raw

    @property
    def code(self) -> str:
        """Normalised code key for G/M words, e.g. G00 -> 'G0', G05.1 -> 'G5.1'."""
        v = self.value
        if float(v).is_integer():
            return f"{self.letter}{int(v)}"
        return f"{self.letter}{v:g}"


@dataclass
class Block:
    index: int  # 0-based index into the list of blocks
    line: int  # 1-based source line number
    text: str  # original source text of the line (trimmed)
    words: list[Word] = field(default_factory=list)
    comment: str | None = None
    block_delete: bool = False
    sequence: int | None = None  # N number
    program_number: str | None = None  # O number
    lex_errors: list[str] = field(default_factory=list)
    macro: bool = False

    def get(self, letter: str) -> Word | None:
        for w in self.words:
            if w.letter == letter:
                return w
        return None

    def all(self, letter: str) -> list[Word]:
        return [w for w in self.words if w.letter == letter]

    def has(self, letter: str) -> bool:
        return any(w.letter == letter for w in self.words)


def _strip_comments(line: str) -> tuple[str, str | None, str | None]:
    """Remove (...) and ;... comments. Returns (code, comment, error)."""
    out: list[str] = []
    comments: list[str] = []
    error = None
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "(":
            end = line.find(")", i + 1)
            if end == -1:
                comments.append(line[i + 1 :].strip())
                error = "Unclosed '(' comment"
                break
            comments.append(line[i + 1 : end].strip())
            i = end + 1
            continue
        if ch == ";":
            comments.append(line[i + 1 :].strip())
            break
        out.append(ch)
        i += 1
    comment = " ".join(c for c in comments if c) or None
    return "".join(out), comment, error


def tokenize(text: str) -> list[Block]:
    blocks: list[Block] = []
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        code, comment, err = _strip_comments(stripped)
        code = code.strip().upper()
        block = Block(index=len(blocks), line=line_no, text=stripped, comment=comment)
        if err:
            block.lex_errors.append(err)

        if code.startswith("%"):
            code = code[1:].strip()
            if not code:
                if comment:
                    blocks.append(block)
                continue
        if code.startswith("/"):
            block.block_delete = True
            code = code[1:].lstrip()

        if _MACRO_RE.search(code):
            block.macro = True
            blocks.append(block)
            continue

        # Program number O1234 / :1234
        m = re.match(r"^[O:]\s*(\d+)", code)
        if m:
            block.program_number = m.group(1)
            code = code[m.end() :]

        pos = 0
        compact = code
        leftovers: list[str] = []
        for m in _WORD_RE.finditer(compact):
            gap = compact[pos : m.start()]
            if gap.strip():
                leftovers.append(gap.strip())
            letter, num = m.group(1), m.group(2)
            if letter == "N" and block.sequence is None and not block.words:
                block.sequence = int(float(num))
            else:
                block.words.append(Word(letter, float(num), num))
            pos = m.end()
        tail = compact[pos:]
        if tail.strip():
            leftovers.append(tail.strip())
        for bad in leftovers:
            block.lex_errors.append(f"Unrecognised text '{bad}'")

        if block.words or block.comment or block.lex_errors or block.program_number:
            blocks.append(block)
    return blocks
