/**
 * NC Optimiser, phase 2: load-based feed optimisation.
 *
 * Only F words change. Every other character of the program is kept, and the
 * optimised program is interpreted again to prove the toolpath is identical.
 *
 * Rules (each one can be switched off):
 *  - Chip thinning: light radial engagement (< 90°) makes thinner chips than
 *    the programmed feed per tooth. The feed is raised towards the programmed
 *    chip thickness, capped by "max increase".
 *  - Heavy load: heavy (120–170°) and full-width / plunge moves are slowed.
 *  - Air: feed moves that stay clear of the stock by at least "air gap" are
 *    sped up. Moves the stock model cannot see clearly (spring passes, thin
 *    finishing allowance) are not air: their gap is near zero.
 *
 * Never changed: rapids, drilling / tapping / boring cycles, feed per rev
 * (G95) or inverse time (G93) blocks, block-delete (/) lines, lines that were
 * not executed. A program that stopped verification is not optimised.
 */
import { interpret } from "../engine/interpreter";
import { tokenize } from "../engine/lexer";
import type { InterpreterSettings } from "../engine/interpreter";
import type { InterpretResponse, Move } from "../types";
import type { Analysis } from "./analysis";

export type Controller = "fanuc" | "m80";

export interface FeedSettings {
  chipThinning: boolean;
  /** % above the programmed feed, at most. */
  maxIncrease: number;
  heavy: boolean;
  /** % of programmed feed for heavy (120–170°) engagement. */
  heavyPct: number;
  /** % of programmed feed for full-width cuts and plunges. */
  fullPct: number;
  /** Slow down only when the axial depth ap is at least this % of the tool diameter (shallow full-width cuts are light). */
  heavyApPct: number;
  air: boolean;
  /** % of programmed feed for air moves. */
  airPct: number;
  /** Minimum clearance to the stock for a move to count as air, mm. */
  airGap: number;
  minFeed: number;
  /** Machine / tool maximum cutting feed, mm/min. */
  maxFeed: number;
  /** Feeds are rounded to this step, mm/min. */
  step: number;
  /** Changes smaller than this % are not written. */
  minChange: number;
  controller: Controller;
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  chipThinning: true,
  maxIncrease: 30,
  heavy: true,
  heavyPct: 90,
  fullPct: 75,
  heavyApPct: 10,
  air: true,
  airPct: 200,
  airGap: 2,
  minFeed: 50,
  maxFeed: 10000,
  step: 10,
  minChange: 5,
  controller: "fanuc",
};

export type Reason = "thin" | "heavy" | "full" | "air";

export const REASONS: Record<Reason, { label: string; color: string }> = {
  thin: { label: "Chip thinning (raised)", color: "#2563eb" },
  air: { label: "Air (raised)", color: "#94a3b8" },
  heavy: { label: "Heavy load (reduced)", color: "#f59e0b" },
  full: { label: "Full width / plunge (reduced)", color: "#c2410c" },
};

export interface LineChange {
  line: number;
  oldF: number;
  newF: number;
  reason: Reason;
}

export interface FeedPlan {
  ok: boolean;
  /** Why the program cannot be optimised (when ok is false). */
  blocked: string | null;
  /** New feed per move, aligned with moves (NaN = unchanged / not a feed move). */
  moveFeed: Float32Array;
  changes: LineChange[];
  text: string;
  filename: string;
  check: { ok: boolean; message: string; moves: number; oldTime: number; newTime: number; cutOld: number; cutNew: number } | null;
  stats: { raised: number; reduced: number; written: number; byReason: Record<Reason, { lines: number; saved: number }> };
}

const EMPTY_STATS = () => ({ raised: 0, reduced: 0, written: 0, byReason: { thin: { lines: 0, saved: 0 }, air: { lines: 0, saved: 0 }, heavy: { lines: 0, saved: 0 }, full: { lines: 0, saved: 0 } } });

const isCut = (m: Move) => m.kind === "feed" || m.kind === "arc";

function blockedPlan(reason: string, n: number): FeedPlan {
  return { ok: false, blocked: reason, moveFeed: new Float32Array(n).fill(NaN), changes: [], text: "", filename: "", check: null, stats: EMPTY_STATS() };
}

/** F value formatted like the source program (keeps a trailing "." if the program uses one). */
function fmtF(v: number, decimal: boolean): string {
  const s = Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  return decimal && !s.includes(".") ? `${s}.` : s;
}

const F_RE = /F\s*[+-]?(?:\d+\.?\d*|\.\d+)/i;

/** Replace the F word outside comments, or append one before any trailing comment. */
function setF(raw: string, f: string, spaced: boolean): string {
  let code = "";
  let i = 0;
  // Find code segments outside ( ) and after ';'.
  const parts: { text: string; code: boolean }[] = [];
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "(") {
      const end = raw.indexOf(")", i + 1);
      const j = end === -1 ? raw.length : end + 1;
      if (code) parts.push({ text: code, code: true });
      code = "";
      parts.push({ text: raw.slice(i, j), code: false });
      i = j;
      continue;
    }
    if (ch === ";") {
      if (code) parts.push({ text: code, code: true });
      code = "";
      parts.push({ text: raw.slice(i), code: false });
      i = raw.length;
      break;
    }
    code += ch;
    i++;
  }
  if (code) parts.push({ text: code, code: true });
  for (const p of parts) {
    if (p.code && F_RE.test(p.text)) {
      p.text = p.text.replace(F_RE, `F${f}`);
      return parts.map((q) => q.text).join("");
    }
  }
  // Append after the last code segment.
  let last = -1;
  parts.forEach((p, k) => {
    if (p.code && p.text.trim()) last = k;
  });
  if (last === -1) return raw;
  const t = parts[last].text;
  const trail = t.match(/\s*$/)![0];
  const body = t.slice(0, t.length - trail.length);
  const sep = spaced ? " " : "";
  parts[last].text = `${body}${sep}F${f}${trail}`;
  return parts.map((q) => q.text).join("");
}

export function planFeeds(
  result: InterpretResponse,
  analysis: Analysis,
  text: string,
  interpSettings: InterpreterSettings,
  s: FeedSettings,
): FeedPlan {
  const moves = result.moves;
  const n = moves.length;
  const L = result.load;
  if (!L) return blockedPlan("No cutting-load data for this program.", n);
  if (result.summary.status === "halted") return blockedPlan("Verification stopped on this program, so it is not optimised. Fix the stop first.", n);

  // ---------------------------------------------------------------- per-move target feed
  const moveFeed = new Float32Array(n).fill(NaN);
  const moveReason: (Reason | null)[] = new Array(n).fill(null);
  const toolD = new Map<number | null, number>();
  for (const t of result.tools) toolD.set(t.key === "none" ? null : Number(t.key), t.diameter);
  // The stock model is a grid: between grid points real material can sit closer than the model says.
  const g = result.stock.grid;
  const airGap = Math.max(s.airGap, 1.5 * Math.max(g.cx, g.cy));
  const q = (v: number) => Math.max(s.step, Math.round(v / s.step) * s.step);
  for (let i = 0; i < n; i++) {
    const m = moves[i];
    if (!isCut(m) || m.op !== "mill" || !m.feed) continue;
    const lv = analysis.level[i];
    if (lv < 0) continue;
    const F = m.feed;
    let ratio = 1;
    let reason: Reason | null = null;
    if (lv === 0 || L.removed[i] <= 0) {
      // Decided per move: a move inside a cutting window can still be in air.
      if (s.air && L.gap[i] >= airGap) {
        ratio = s.airPct / 100;
        reason = "air";
      }
    } else if (lv >= 3 && analysis.values.ap[i] < (s.heavyApPct / 100) * (toolD.get(m.tool) ?? 10)) {
      continue;
    } else if (lv === 4) {
      // A straight Z plunge keeps the plunge feed the CAM system chose for it.
      if (L.plunge[i] && L.lxy[i] < 0.01) continue;
      if (s.heavy) [ratio, reason] = [s.fullPct / 100, "full"];
    } else if (lv === 3) {
      if (s.heavy) [ratio, reason] = [s.heavyPct / 100, "heavy"];
    } else if (s.chipThinning) {
      const a = analysis.values.angle[i];
      if (a > 0 && a < 90) {
        ratio = Math.min(1 / Math.sin((a * Math.PI) / 180), 1 + s.maxIncrease / 100);
        reason = "thin";
      }
    }
    if (!reason || Math.abs(ratio - 1) < 1e-6) continue;
    let f = F * ratio;
    if (ratio > 1) f = Math.min(f, Math.max(F, s.maxFeed));
    else f = Math.max(f, Math.min(F, s.minFeed));
    f = q(f);
    if (Math.abs(f - F) / F * 100 < s.minChange) continue;
    moveFeed[i] = f;
    moveReason[i] = reason;
  }

  // ---------------------------------------------------------------- per-line decision
  // A line may produce several moves; it takes the lowest target, and any
  // move that must keep its feed keeps the whole line.
  const lineMoves = new Map<number, number[]>();
  moves.forEach((m, i) => {
    if (m.kind === "rapid" || isCut(m)) {
      const a = lineMoves.get(m.line);
      if (a) a.push(i);
      else lineMoves.set(m.line, [i]);
    }
  });
  const executed = new Set(result.blocks.filter((b) => b.status === "executed").map((b) => b.line));
  const feedLines = new Set<number>();
  const lineTarget = new Map<number, { f: number; reason: Reason }>();
  for (const [line, idx] of lineMoves) {
    const cuts = idx.filter((i) => isCut(moves[i]));
    if (!cuts.length) continue;
    feedLines.add(line);
    if (idx.some((i) => !isCut(moves[i]) || Number.isNaN(moveFeed[i]))) {
      if (cuts.every((i) => Number.isNaN(moveFeed[i]))) continue;
      // Mixed line (e.g. a cycle or a partly-changed comp corner): keep it.
      for (const i of cuts) moveFeed[i] = NaN;
      continue;
    }
    let best = Infinity;
    let reason: Reason = moveReason[cuts[0]]!;
    for (const i of cuts) if (moveFeed[i] < best) [best, reason] = [moveFeed[i], moveReason[i]!];
    for (const i of cuts) moveFeed[i] = best;
    lineTarget.set(line, { f: best, reason });
  }

  // ---------------------------------------------------------------- smoothing
  // A feed change must hold for at least one tool diameter of path; shorter
  // runs flip F back and forth on every line, which the machine cannot follow.
  const lineLen = new Map<number, number>();
  const lineTool = new Map<number, number | null>();
  moves.forEach((m) => {
    if (!isCut(m)) return;
    lineLen.set(m.line, (lineLen.get(m.line) ?? 0) + m.length);
    lineTool.set(m.line, m.tool);
  });
  const order = [...feedLines].sort((a, b) => a - b);
  for (let a = 0; a < order.length; ) {
    const t = lineTarget.get(order[a]);
    let b = a + 1;
    while (b < order.length && lineTarget.get(order[b])?.f === t?.f) b++;
    if (t) {
      let len = 0;
      for (let k = a; k < b; k++) len += lineLen.get(order[k]) ?? 0;
      const D = toolD.get(lineTool.get(order[a]) ?? null) ?? 10;
      if (len < D) for (let k = a; k < b; k++) lineTarget.delete(order[k]);
    }
    a = b;
  }

  // ---------------------------------------------------------------- rewrite F words
  const blocks = tokenize(text);
  const byLine = new Map(blocks.map((b) => [b.line, b]));
  const srcLines = text.split(/\r\n|\r|\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Keep the program's own style: spaces between words, decimal point on F.
  const spaced = blocks.filter((b) => b.words.length > 1).slice(0, 200).some((b) => /[0-9.]\s+[A-Z]/i.test(b.text.replace(/\(.*?\)/g, "")));
  const decimal = blocks.some((b) => b.words.some((w) => w.letter === "F" && w.hasDecimalPoint));
  let progF: number | null = null; // modal F of the original program
  let outF: number | null = null; // modal F of the optimised program (null = unknown)
  let feedMode = "G94";
  const changes: LineChange[] = [];
  const out = srcLines.slice();
  const stats = EMPTY_STATS();
  for (let k = 0; k < srcLines.length; k++) {
    const line = k + 1;
    const b = byLine.get(line);
    if (!b) continue;
    const fw = b.get("F");
    for (const w of b.words) if (w.letter === "G" && (w.value === 93 || w.value === 94 || w.value === 95)) feedMode = `G${w.value}`;
    if (fw) progF = fw.value;
    const untouchable = b.blockDelete || !executed.has(line) || b.macro;
    if (untouchable) {
      if (fw) outF = null;
      continue;
    }
    if (!feedLines.has(line)) {
      if (fw) outF = fw.value;
      continue;
    }
    const t = feedMode === "G94" ? lineTarget.get(line) : undefined;
    const want = t ? t.f : progF;
    if (want === null) continue;
    if (fw) {
      if (want !== fw.value) out[k] = setF(srcLines[k], fmtF(want, decimal), spaced);
    } else if (outF !== want) {
      out[k] = setF(srcLines[k], fmtF(want, decimal), spaced);
    }
    if (out[k] !== srcLines[k]) stats.written++;
    outF = want;
    if (t && progF !== null) {
      changes.push({ line, oldF: progF, newF: t.f, reason: t.reason });
      if (t.f > progF) stats.raised++;
      else stats.reduced++;
      stats.byReason[t.reason].lines++;
    }
  }
  const changed = new Set(changes.map((c) => c.line));
  moves.forEach((m, i) => {
    if (!changed.has(m.line)) moveFeed[i] = NaN;
  });
  if (!changes.length) {
    return { ok: true, blocked: null, moveFeed, changes, text, filename: "", check: null, stats };
  }

  // Header comment after the program number / '%' line.
  const ctrl = s.controller === "m80" ? "MITSUBISHI M80" : "FANUC";
  const header = `(CAMI NC OPTIMISER - FEEDS ONLY - ${changes.length} LINES CHANGED - ${ctrl})`;
  let at = 0;
  while (at < out.length && (/^\s*%/.test(out[at]) || /^\s*$/.test(out[at]))) at++;
  if (at < out.length && /^\s*O\s*\d+/i.test(out[at])) at++;
  out.splice(at, 0, header);
  const newText = out.join(eol);

  // ---------------------------------------------------------------- prove the geometry is unchanged
  const settings = { ...interpSettings, comp_radii: new Map(interpSettings.comp_radii) };
  const before = interpret(text, settings);
  const after = interpret(newText, { ...interpSettings, comp_radii: new Map(interpSettings.comp_radii) });
  const check = compare(before.moves, after.moves);
  const sumT = (ms: Move[], f: (m: Move) => boolean) => ms.filter(f).reduce((a, m) => a + m.duration, 0);
  const all = () => true;
  // Time saved per reason.
  const byLineOld = new Map<number, number>();
  const byLineNew = new Map<number, number>();
  before.moves.forEach((m) => byLineOld.set(m.line, (byLineOld.get(m.line) ?? 0) + m.duration));
  after.moves.forEach((m) => byLineNew.set(m.line > at ? m.line - 1 : m.line, (byLineNew.get(m.line > at ? m.line - 1 : m.line) ?? 0) + m.duration));
  for (const c of changes) stats.byReason[c.reason].saved += (byLineOld.get(c.line) ?? 0) - (byLineNew.get(c.line) ?? 0);

  const base = result.program.filename.replace(/\.[^.]*$/, "");
  const ext = (result.program.filename.match(/\.[^.]*$/)?.[0] ?? ".nc").toLowerCase();
  return {
    ok: true,
    blocked: null,
    moveFeed,
    changes,
    text: newText,
    filename: `${base}_OPT${s.controller === "m80" ? "_M80" : ""}${ext}`,
    check: {
      ...check,
      oldTime: sumT(before.moves, all),
      newTime: sumT(after.moves, all),
      cutOld: sumT(before.moves, isCut),
      cutNew: sumT(after.moves, isCut),
    },
    stats,
  };
}

function compare(a: Move[], b: Move[]): { ok: boolean; message: string; moves: number } {
  if (a.length !== b.length) return { ok: false, message: `Move count differs (${a.length} vs ${b.length}).`, moves: a.length };
  const near = (p: number[], q: number[]) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[2] - q[2]) < 1e-6;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind || x.op !== y.op || x.tool !== y.tool || x.spindle !== y.spindle || x.coolant !== y.coolant)
      return { ok: false, message: `Move ${i + 1} (line ${x.line}) changed type, tool, spindle or coolant.`, moves: a.length };
    if (!near(x.start, y.start) || !near(x.end, y.end))
      return { ok: false, message: `Move ${i + 1} (line ${x.line}) changed position.`, moves: a.length };
    const pa = x.points ?? [];
    const pb = y.points ?? [];
    if (pa.length !== pb.length || pa.some((p, k) => !near(p, pb[k])))
      return { ok: false, message: `Move ${i + 1} (line ${x.line}) changed its arc or path points.`, moves: a.length };
    if (x.kind === "rapid" && x.feed !== y.feed) return { ok: false, message: `Rapid on line ${x.line} changed.`, moves: a.length };
    if (x.op !== "mill" && x.feed !== y.feed) return { ok: false, message: `Cycle feed on line ${x.line} changed.`, moves: a.length };
  }
  return { ok: true, message: `All ${a.length.toLocaleString()} moves have identical positions, arcs, tools and spindle. Only feeds differ.`, moves: a.length };
}
