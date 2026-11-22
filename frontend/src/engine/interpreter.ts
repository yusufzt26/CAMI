/**
 * Modal G-code interpreter. Port of backend app/gcode/interpreter.py, kept
 * line-for-line close so the two engines give the same results.
 */
import type { BlockRow, Diagnostic, Move, MoveKind, OpKind, Severity, Summary, Vec3 } from "../types";
import { CompError, CutterComp, type Element } from "./cutterComp";
import { type ControllerDialect, getDialect } from "./dialect";
import { ArcError, type Plane, arcCenterFromOffsets, arcCenterFromRadius, buildArc, dist, doglegPoints, polylineLength } from "./geometry";
import { type Block, Word, fmtG, tokenize } from "./lexer";

export const WCS_CODES = ["G54", "G55", "G56", "G57", "G58", "G59"];

export interface InterpreterSettings {
  controller: string;
  initial_units: "mm" | "inch";
  work_offsets: Record<string, Vec3>;
  reference_position: Vec3;
  rapid_rate: number;
  max_feed: number;
  tool_change_time: number;
  decimal_mode: "calculator" | "least_increment";
  rapid_mode: "linear" | "dogleg";
  block_delete_switch: boolean;
  cutter_comp_mode: "tool_radius" | "zero";
  comp_radii: Map<number, number>;
  arc_radius_tolerance: number;
  chord_tolerance: number;
}

export function defaultSettings(): InterpreterSettings {
  return {
    controller: "fanuc",
    initial_units: "mm",
    work_offsets: Object.fromEntries(WCS_CODES.map((c) => [c, [0, 0, 0] as Vec3])),
    reference_position: [0, 0, 100],
    rapid_rate: 15000,
    max_feed: 10000,
    tool_change_time: 6,
    decimal_mode: "calculator",
    rapid_mode: "linear",
    block_delete_switch: false,
    cutter_comp_mode: "tool_radius",
    comp_radii: new Map(),
    arc_radius_tolerance: 0.02,
    chord_tolerance: 0.005,
  };
}

const AXES = ["X", "Y", "Z"] as const;
const POSITION_LETTERS = new Set(["X", "Y", "Z", "I", "J", "K", "R", "Q"]);
const CYCLE_OPS: Record<string, OpKind> = {
  G73: "drill",
  G81: "drill",
  G82: "drill",
  G83: "drill",
  G74: "tap",
  G84: "tap",
  G76: "bore",
  G85: "bore",
  G86: "bore",
  G88: "bore",
  G89: "bore",
};
const MAX_DIAGS_PER_CODE = 25;
const STARTUP_GROUPS: Record<string, string> = { distance: "G90/G91", plane: "G17/G18/G19", units: "G20/G21", wcs: "G54-G59" };

class Halt extends Error {}

type Letters = Map<string, Word>;

interface State {
  pos: Vec3;
  units: string;
  distance: string;
  plane: Plane;
  motion: string | null;
  cycle: string | null;
  cycle_return: string;
  cycle_initial_z: number | null;
  cycle_r: number | null;
  cycle_z: number | null;
  cycle_q: number | null;
  cycle_p: number | null;
  feed: number | null;
  feed_mode: string;
  spindle_speed: number;
  spindle_dir: number;
  coolant: boolean;
  selected_tool: number | null;
  tool: number | null;
  h_offset: number | null;
  d_offset: number | null;
  cutter_comp: string;
  length_comp: boolean;
  wcs: string;
  g52: Vec3;
  g92: Vec3;
  rigid_tap: boolean;
  ended: boolean;
}

interface RawMove {
  kind: MoveKind;
  op: OpKind;
  block: number;
  line: number;
  start: Vec3;
  end: Vec3;
  duration: number;
  length: number;
  feed: number | null;
  tool: number | null;
  spindle: number;
  coolant: boolean;
  points: Vec3[] | null;
  note: string | null;
}

export interface InterpretResult {
  blocks: BlockRow[];
  moves: Move[];
  diagnostics: Diagnostic[];
  summary: Summary;
  settings: Record<string, unknown>;
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const rn = (v: number, n: number) => Math.round(v * 10 ** n) / 10 ** n;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const copy = (p: readonly number[]) => [p[0], p[1], p[2]] as Vec3;

function moveToDict(m: RawMove): Move {
  const d: Move = {
    kind: m.kind,
    op: m.op,
    block: m.block,
    line: m.line,
    start: m.start.map(r5) as Vec3,
    end: m.end.map(r5) as Vec3,
    duration: r5(m.duration),
    length: r5(m.length),
    feed: m.feed,
    tool: m.tool,
    spindle: m.spindle,
    coolant: m.coolant,
  };
  if (m.points !== null) d.points = m.points.map((p) => p.map(r5) as Vec3);
  if (m.note) d.note = m.note;
  return d;
}

export class Interpreter {
  readonly dialect: ControllerDialect;
  moves: RawMove[] = [];
  diags: Diagnostic[] = [];
  private diagCounts = new Map<string, number>();
  private once = new Set<string>();
  haltedAt: number | null = null;
  private explicitGroups = new Set<string>();
  private motionSeen = false;
  private noDecimal: number[] = [];
  private toolNeedsG43 = new Set<number>();
  private executedBlocks = 0;
  toolPos: Vec3;
  private st!: State;
  readonly comp: CutterComp;
  private compUsed = false;

  constructor(readonly settings: InterpreterSettings) {
    this.dialect = getDialect(settings.controller);
    this.toolPos = copy(settings.reference_position);
    this.comp = new CutterComp(
      (b, k, s, e, f) => this.compLine(b, k, s, e, f),
      (b, s, e, c, cw, f, p, l) => this.compArc(b, s, e, c, cw, f, p, l),
      settings.chord_tolerance,
    );
  }

  // ------------------------------------------------------------------ utils
  diag(severity: Severity, code: string, message: string, block: Block | null = null, halt = false, onceKey: string | null = null) {
    if (onceKey !== null) {
      if (this.once.has(onceKey)) return;
      this.once.add(onceKey);
    }
    const n = (this.diagCounts.get(code) ?? 0) + 1;
    this.diagCounts.set(code, n);
    if (n > MAX_DIAGS_PER_CODE && !halt) return;
    this.diags.push({ severity, code, message, line: block ? block.line : null, block: block ? block.index : null, halt });
    if (halt) throw new Halt(message);
  }

  private wcsOffset(name: string): Vec3 {
    return this.settings.work_offsets[name] ?? [0, 0, 0];
  }

  offset(st: State): Vec3 {
    const w = this.wcsOffset(st.wcs);
    return [0, 1, 2].map((i) => w[i] + st.g52[i] + st.g92[i]) as Vec3;
  }
  toWork(st: State, m: readonly number[]): Vec3 {
    const o = this.offset(st);
    return [m[0] - o[0], m[1] - o[1], m[2] - o[2]];
  }
  toMachine(st: State, w: readonly number[]): Vec3 {
    const o = this.offset(st);
    return [w[0] + o[0], w[1] + o[1], w[2] + o[2]];
  }
  toDisplay(m: readonly number[]): Vec3 {
    const g = this.wcsOffset("G54");
    return [m[0] - g[0], m[1] - g[1], m[2] - g[2]];
  }
  scale(st: State) {
    return st.units === "inch" ? 25.4 : 1;
  }
  value(st: State, w: Word, block: Block): number {
    let v = w.value;
    if (POSITION_LETTERS.has(w.letter) && !w.hasDecimalPoint && v !== 0) {
      this.noDecimal.push(block.line);
      if (this.settings.decimal_mode === "least_increment") v = v * (st.units === "inch" ? 0.0001 : 0.001);
    }
    return v * this.scale(st);
  }
  feedValue(st: State, w: Word) {
    return w.value * this.scale(st);
  }

  // ------------------------------------------------------------ main entry
  run(text: string): InterpretResult {
    const blocks = tokenize(text);
    const s = this.settings;
    const st: State = {
      pos: copy(s.reference_position),
      units: s.initial_units,
      distance: "G90",
      plane: "G17",
      motion: null,
      cycle: null,
      cycle_return: "G98",
      cycle_initial_z: null,
      cycle_r: null,
      cycle_z: null,
      cycle_q: null,
      cycle_p: null,
      feed: null,
      feed_mode: "G94",
      spindle_speed: 0,
      spindle_dir: 0,
      coolant: false,
      selected_tool: null,
      tool: null,
      h_offset: null,
      d_offset: null,
      cutter_comp: "G40",
      length_comp: false,
      wcs: "G54",
      g52: [0, 0, 0],
      g92: [0, 0, 0],
      rigid_tap: false,
      ended: false,
    };
    this.st = st;
    const status = new Map<number, BlockRow["status"]>();
    for (const block of blocks) {
      if (st.ended) {
        if (block.words.length) {
          status.set(block.index, "after_end");
          this.diag("info", "AFTER_END", "Blocks after M02/M30 were not simulated.", block, false, "after_end");
        }
        continue;
      }
      try {
        const executed = this.execute(block, st);
        status.set(block.index, executed ? "executed" : "skipped");
        if (executed) this.executedBlocks++;
      } catch (e) {
        if (!(e instanceof Halt)) throw e;
        status.set(block.index, "halted");
        this.haltedAt = block.index;
        break;
      }
    }
    if (this.haltedAt === null) {
      try {
        this.comp.cancel();
      } catch (e) {
        if (!(e instanceof CompError)) throw e;
      }
    }
    if (this.haltedAt !== null) for (const b of blocks.slice(this.haltedAt + 1)) status.set(b.index, "not_run");
    this.finish(st);
    const summary = this.summary(blocks, st);
    return {
      blocks: blocks.map((b) => ({ index: b.index, line: b.line, text: b.text, status: status.get(b.index) ?? "not_run" })),
      moves: this.moves.map(moveToDict),
      diagnostics: this.diags,
      summary,
      settings: {
        controller: s.controller,
        controller_name: this.dialect.name,
        initial_units: s.initial_units,
        work_offsets: s.work_offsets,
        reference_position: s.reference_position,
        rapid_rate: s.rapid_rate,
        max_feed: s.max_feed,
        decimal_mode: s.decimal_mode,
        rapid_mode: s.rapid_mode,
        block_delete_switch: s.block_delete_switch,
        cutter_comp_mode: s.cutter_comp_mode,
      },
    };
  }

  // ---------------------------------------------------------------- blocks
  execute(block: Block, st: State): boolean {
    if (block.lexErrors.length) this.diag("error", "SYNTAX", `${block.lexErrors.join("; ")}. Verification stopped.`, block, true);
    if (block.macro)
      this.diag(
        "error",
        "MACRO",
        "Custom macro / variable statement (#, IF, GOTO, WHILE) is not supported yet. " +
          "Verification stopped because the tool path after this point cannot be known.",
        block,
        true,
      );
    if (!block.words.length) return false;
    if (block.blockDelete) {
      if (this.settings.block_delete_switch) {
        this.diag("info", "BLOCK_DELETE", "Block skipped: Block Delete switch is ON.", block);
        return false;
      }
      this.diag(
        "warning",
        "BLOCK_DELETE",
        "Block starts with '/'. Simulated with the Block Delete switch OFF (block executed). Check the operator panel setting on the machine.",
        block,
      );
    }

    const gCodes: string[] = [];
    const mCodes: string[] = [];
    const seen: Letters = new Map();
    for (const w of block.words) {
      if (w.letter === "G") {
        gCodes.push(w.code);
        continue;
      }
      if (w.letter === "M") {
        mCodes.push(w.code);
        continue;
      }
      if (this.dialect.foreignAxes.has(w.letter))
        this.diag("error", "FOREIGN_AXIS", `Address ${w.letter} refers to an axis that a 3-axis VMC does not have. Verification stopped.`, block, true);
      if (!(w.letter in this.dialect.letters)) this.diag("error", "UNKNOWN_ADDRESS", `Unknown address '${w.letter}${w.raw}'. Verification stopped.`, block, true);
      if (seen.has(w.letter))
        this.diag("error", "DUPLICATE_ADDRESS", `Address ${w.letter} appears twice in one block (controller alarm). Verification stopped.`, block, true);
      seen.set(w.letter, w);
    }

    const groups = new Map<string, string>();
    for (const code of [...gCodes, ...mCodes]) {
      const spec = this.dialect.codes.get(code);
      if (!spec) {
        this.diag(
          "error",
          "UNKNOWN_CODE",
          `${code} is not a recognised ${this.dialect.name} code. It could affect machining, so verification stopped.`,
          block,
          true,
        );
        continue;
      }
      if (spec.support === "unsupported") {
        const extra = spec.note ? ` ${spec.note}` : "";
        this.diag("error", "UNSUPPORTED_CODE", `${code} (${spec.description}) is not supported by this simulator yet.${extra} Verification stopped at this block.`, block, true);
      }
      if (groups.has(spec.group) && spec.group !== "nonmodal" && code.startsWith("G"))
        this.diag("error", "MODAL_CONFLICT", `${groups.get(spec.group)} and ${code} are in the same modal group (${spec.group}). Verification stopped.`, block, true);
      if (!groups.has(spec.group)) groups.set(spec.group, code);
      if (spec.support === "no_effect") this.diag("info", "NO_EFFECT", `${code} (${spec.description}) has no effect on the simulated path.`, block, false, `noeffect:${code}`);
      if (spec.support === "limited" && spec.note && !["G28", "G53", "G41", "G42"].includes(code))
        this.diag("warning", "LIMITED", `${code} (${spec.description}): ${spec.note}`, block, false, `limited:${code}`);
    }

    if (gCodes.includes("G5")) this.g05(block, seen, gCodes);

    const axisNonmodal = gCodes.filter((c) => ["G28", "G53", "G92", "G52", "G4"].includes(c));
    if (axisNonmodal.length > 1) this.diag("error", "MODAL_CONFLICT", `${axisNonmodal.join(" and ")} cannot be combined in one block. Verification stopped.`, block, true);

    for (const grp of Object.keys(STARTUP_GROUPS)) if (groups.has(grp)) this.explicitGroups.add(grp);

    if (groups.has("units")) {
      const nu = groups.get("units") === "G20" ? "inch" : "mm";
      if (nu !== st.units && this.motionSeen) this.diag("warning", "UNITS_CHANGE", `Units changed to ${nu} after motion had started.`, block);
      st.units = nu;
    }
    if (groups.has("plane")) st.plane = groups.get("plane") as Plane;
    if (groups.has("distance")) st.distance = groups.get("distance")!;
    if (groups.has("feed_mode")) st.feed_mode = groups.get("feed_mode")!;
    if (groups.has("cycle_return")) st.cycle_return = groups.get("cycle_return")!;
    if (seen.has("F")) {
      const f = this.feedValue(st, seen.get("F")!);
      if (f <= 0) this.diag("error", "FEED_ZERO", "F0 / negative feed rate programmed.", block);
      st.feed = f;
    }
    if (seen.has("S")) st.spindle_speed = seen.get("S")!.value;
    if (seen.has("T")) st.selected_tool = Math.trunc(seen.get("T")!.value);
    if (groups.has("spindle")) {
      const sp = groups.get("spindle")!;
      st.spindle_dir = ({ M3: 1, M4: -1, M5: 0 } as Record<string, number>)[sp];
      if (st.spindle_dir !== 0 && st.spindle_speed <= 0) this.diag("warning", "SPINDLE_NO_SPEED", `${sp} with no spindle speed (S) programmed.`, block);
    }
    if (groups.has("coolant")) st.coolant = groups.get("coolant") !== "M9";
    if (groups.has("rigid_tap")) st.rigid_tap = true;
    if (groups.has("wcs")) {
      st.wcs = groups.get("wcs")!;
      const off = this.wcsOffset(st.wcs);
      const g54 = this.settings.work_offsets["G54"];
      if (st.wcs !== "G54" && g54 && off.every((v, i) => v === g54[i]))
        this.diag(
          "warning",
          "WCS_SAME",
          `${st.wcs} is used but its offset equals G54. Enter the ${st.wcs} offset in Job Setup if it differs.`,
          block,
          false,
          `wcs_same:${st.wcs}`,
        );
    }

    const motionCode = groups.get("motion") ?? null;
    let compStartup = false;
    let compCancel = false;
    if (groups.has("cutter_comp")) {
      const nc = groups.get("cutter_comp")!;
      const eff = motionCode ?? st.motion;
      if (nc !== st.cutter_comp && (eff === "G2" || eff === "G3") && hasAxes(seen))
        this.diag("error", "COMP_ON_ARC", `Cutter compensation ${nc} started/cancelled in a G02/G03 block (controller alarm). Verification stopped.`, block, true);
      if (nc === "G41" || nc === "G42") {
        if (seen.has("D")) st.d_offset = Math.trunc(seen.get("D")!.value);
        else if (st.d_offset === null) this.diag("warning", "COMP_NO_D", `${nc} without a D offset number.`, block);
        if (nc !== st.cutter_comp) {
          if (st.plane !== "G17") this.diag("error", "COMP_PLANE", `${nc} in ${st.plane} is not supported yet (XY plane only). Verification stopped.`, block, true);
          this.compEngage(block, st, nc);
          compStartup = this.comp.active;
        }
      } else if (nc === "G40" && st.cutter_comp !== "G40") compCancel = true;
      st.cutter_comp = nc;
    } else if (seen.has("D")) st.d_offset = Math.trunc(seen.get("D")!.value);

    if (groups.has("length_comp")) {
      if (groups.get("length_comp") === "G43") {
        st.length_comp = true;
        if (seen.has("H")) st.h_offset = Math.trunc(seen.get("H")!.value);
        else this.diag("warning", "G43_NO_H", "G43 without an H number: the active H offset is used.", block);
        if (st.tool !== null) this.toolNeedsG43.delete(st.tool);
        if (st.h_offset !== null && st.tool !== null && st.h_offset !== st.tool)
          this.diag("warning", "H_MISMATCH", `G43 H${st.h_offset} while T${st.tool} is in the spindle. Check the length offset number.`, block);
      } else st.length_comp = false;
    } else if (seen.has("H")) st.h_offset = Math.trunc(seen.get("H")!.value);

    if (groups.has("toolchange")) this.toolChange(block, st);

    if (gCodes.includes("G52")) {
      AXES.forEach((a, i) => {
        if (seen.has(a)) st.g52[i] = this.value(st, seen.get(a)!, block);
      });
      return true;
    }
    if (gCodes.includes("G92")) {
      const machine = st.pos;
      AXES.forEach((a, i) => {
        if (seen.has(a)) {
          const wcs = this.wcsOffset(st.wcs);
          st.g92[i] = machine[i] - wcs[i] - st.g52[i] - this.value(st, seen.get(a)!, block);
        }
      });
      this.diag("warning", "G92", "G92 coordinate shift applied. Confirm it matches the machine setup.", block);
      return true;
    }
    if (gCodes.includes("G4")) {
      this.dwell(block, st, seen);
      this.stops(block, st, groups);
      return true;
    }

    if (motionCode) {
      st.motion = motionCode;
      if (st.cycle) st.cycle = null;
    }
    const cycleCode = groups.get("cycle") ?? null;
    if (cycleCode === "G80") {
      st.cycle = null;
      st.cycle_r = st.cycle_z = st.cycle_q = st.cycle_p = null;
    } else if (cycleCode) {
      if (st.cycle === null) st.cycle_initial_z = this.toWork(st, st.pos)[2];
      st.cycle = cycleCode;
      if (motionCode) this.diag("warning", "CYCLE_WITH_MOTION", `${motionCode} and ${cycleCode} in the same block; the canned cycle takes effect.`, block);
    }

    const g28 = gCodes.includes("G28");
    const g53 = gCodes.includes("G53");
    const xyMotion = hasAxes(seen, false, true) && !(g28 || g53 || st.cycle);
    if (this.comp.active && compCancel && !xyMotion) this.compSafe(block, () => this.comp.cancel());
    else if (this.comp.active && !xyMotion && (g28 || g53 || st.cycle)) {
      this.compSafe(block, () => this.comp.flush());
      this.diag("warning", "COMP_SUSPENDED", "Reference return / canned cycle with cutter compensation active: compensation is suspended for this block.", block);
    }

    if (g28) this.referenceReturn(block, st, seen);
    else if (g53) this.machineMove(block, st, seen, motionCode);
    else if (st.cycle && (hasAxes(seen, true) || (cycleCode && cycleCode !== "G80" && hasAxes(seen)))) {
      this.updateCycleParams(block, st, seen);
      this.cycle(block, st, seen);
    } else if (st.cycle && cycleCode && cycleCode !== "G80") this.updateCycleParams(block, st, seen);
    else if (hasAxes(seen, false, true)) this.motion(block, st, seen, compStartup, compCancel);

    this.stops(block, st, groups);
    return true;
  }

  // ------------------------------------------------------------------ parts
  /** G05 P10000 / P0: AI contour control on / off (no path effect). Other G05 forms halt. */
  private g05(block: Block, letters: Letters, gCodes: string[]) {
    const p = letters.get("P");
    const others = [...[...letters.keys()].filter((l) => l !== "P"), ...gCodes.filter((c) => c === "G4" || c in CYCLE_OPS)];
    if (!p || !(p.value === 0 || p.value === 10000) || others.length)
      this.diag(
        "error",
        "UNSUPPORTED_CODE",
        `G05${p ? " P" + p.raw : ""}${others.length ? " with " + others.join(", ") : ""}: only G05 P10000 (AI contour control on) ` +
          "and G05 P0 (off) are supported. Other forms run high-speed cycle data stored in the control. Verification stopped.",
        block,
        true,
      );
    const state = p!.value ? "on" : "off";
    this.diag("info", "NO_EFFECT", `G05 P${p!.raw} (AI contour control ${state}) changes feed look-ahead only; it has no effect on the simulated path.`, block, false, `g05:${state}`);
  }

  private checkStartup(block: Block) {
    if (this.motionSeen) return;
    this.motionSeen = true;
    const missing = Object.entries(STARTUP_GROUPS)
      .filter(([g]) => !this.explicitGroups.has(g))
      .map(([, l]) => l);
    if (missing.length)
      this.diag(
        "warning",
        "NO_SAFETY_BLOCK",
        `No ${missing.join(", ")} before the first move. The simulator assumed power-on defaults ` +
          "(G90, G17, G21/initial units, G54); the machine will use whatever modal state is active.",
        block,
      );
  }

  private target(block: Block, st: State, letters: Letters): Vec3 {
    const work = this.toWork(st, st.pos);
    AXES.forEach((a, i) => {
      if (letters.has(a)) {
        const v = this.value(st, letters.get(a)!, block);
        work[i] = st.distance === "G91" ? work[i] + v : v;
      }
    });
    return this.toMachine(st, work);
  }

  private emit(
    kind: MoveKind,
    op: OpKind,
    block: Block,
    start: readonly number[],
    end: readonly number[],
    duration: number,
    length: number,
    st: State,
    feed: number | null = null,
    points: Vec3[] | null = null,
    note: string | null = null,
  ) {
    this.moves.push({
      kind,
      op,
      block: block.index,
      line: block.line,
      start: this.toDisplay(start),
      end: this.toDisplay(end),
      duration,
      length,
      feed,
      tool: st.tool,
      spindle: st.spindle_speed * st.spindle_dir,
      coolant: st.coolant,
      points: points && points.length ? points.map((p) => this.toDisplay(p)) : null,
      note,
    });
    if (kind === "rapid" || kind === "feed" || kind === "arc") this.toolPos = copy(end);
  }

  private rapid(block: Block, st: State, target: Vec3, op: OpKind = "position", note: string | null = null) {
    const start = copy(this.toolPos);
    if (dist(start, target) < 1e-9) return;
    const dmax = Math.max(...[0, 1, 2].map((i) => Math.abs(target[i] - start[i])));
    const duration = (dmax / this.settings.rapid_rate) * 60;
    let points: Vec3[] | null = null;
    let length: number;
    if (this.settings.rapid_mode === "dogleg") {
      points = doglegPoints(start, target);
      length = polylineLength(points);
      if (points.length <= 2) points = null;
    } else length = dist(start, target);
    this.emit("rapid", op, block, start, target, duration, length, st, this.settings.rapid_rate, points, note);
    st.pos = copy(target);
  }

  private feedRate(block: Block, st: State): number {
    if (st.feed === null || st.feed <= 0)
      this.diag("error", "NO_FEED", "Cutting move without a feed rate (F). The controller would alarm. Verification stopped.", block, true);
    if (st.feed_mode === "G95") {
      if (st.spindle_speed <= 0 || st.spindle_dir === 0)
        this.diag("error", "G95_NO_SPINDLE", "Feed per revolution (G95) with the spindle stopped. Verification stopped.", block, true);
      return st.feed! * st.spindle_speed;
    }
    return st.feed!;
  }

  private cutChecks(block: Block, st: State) {
    this.checkStartup(block);
    if (st.spindle_dir === 0 || st.spindle_speed <= 0) this.diag("error", "SPINDLE_OFF_CUT", "Cutting move with the spindle stopped (no M03/M04 or S0).", block);
    if (st.tool === null) this.diag("warning", "NO_TOOL", "Cutting starts without a T/M06 tool change; the tool in the spindle is unknown.", block, false, "no_tool");
  }

  private zChecks(block: Block, st: State, start: Vec3, end: Vec3) {
    if (st.tool !== null && this.toolNeedsG43.has(st.tool) && Math.abs(end[2] - start[2]) > 1e-9) {
      this.toolNeedsG43.delete(st.tool);
      this.diag("warning", "NO_G43", `Z moves with T${st.tool} before G43 tool length compensation is active.`, block);
    }
  }

  // -------------------------------------------------- cutter compensation
  private compRadius(block: Block, st: State): number {
    if (this.settings.cutter_comp_mode === "zero") return 0;
    const d = st.d_offset;
    if (d === null || d === 0) return 0;
    const r = this.settings.comp_radii.get(d);
    if (r === undefined) {
      this.diag(
        "warning",
        "COMP_D_UNKNOWN",
        `D${d} has no matching tool T${d} in the tool table, so its radius is unknown. The programmed path is used.`,
        block,
        false,
        `comp_d:${d}`,
      );
      return 0;
    }
    return r;
  }

  private compEngage(block: Block, st: State, code: string) {
    this.compSafe(block, () => this.comp.flush());
    const radius = this.compRadius(block, st);
    this.compUsed = true;
    if (radius <= 0) {
      this.comp.engage(0, 0);
      if (this.settings.cutter_comp_mode === "zero")
        this.diag("info", "CUTTER_COMP", `${code}: simulated with D = 0 (wear-only setting): the program path is the cutter centre.`, block, false, "comp_zero");
      return;
    }
    this.comp.engage(code === "G41" ? 1 : -1, radius);
    this.diag(
      "warning",
      "CUTTER_COMP",
      `${code} D${st.d_offset}: the cutter centre is offset by ${radius.toFixed(3)} mm (radius of T${st.d_offset} in the tool table). ` +
        `If D${st.d_offset} on the machine holds only wear because the CAM output is already the cutter centre path, ` +
        "set 'Cutter comp D value' to 'Wear only' in Job Setup.",
      block,
      false,
      "comp_on",
    );
  }

  private compSafe(block: Block, fn: () => void) {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof CompError)) throw e;
      this.diag("error", "COMP_ERROR", `${e.message} Verification stopped.`, block, true);
    }
    for (const [blk, code, msg] of this.comp.warnings) this.diag("error", code, msg, blk);
    this.comp.warnings.length = 0;
  }

  private compLine(block: Block, kind: string, start: Vec3, end: Vec3, feed: number | null) {
    const st = this.st;
    const length = dist(start, end);
    if (length < 1e-9) return;
    if (kind === "rapid") {
      const dmax = Math.max(...[0, 1, 2].map((i) => Math.abs(end[i] - start[i])));
      this.emit("rapid", "position", block, start, end, (dmax / this.settings.rapid_rate) * 60, length, st, this.settings.rapid_rate, null, "cutter comp");
    } else this.emit("feed", "mill", block, start, end, (length / feed!) * 60, length, st, feed, null, "cutter comp");
  }

  private compArc(block: Block, start: Vec3, end: Vec3, center: Vec3, cw: boolean, feed: number | null, points: Vec3[], length: number) {
    const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
    this.emit("arc", "mill", block, start, end, (length / feed!) * 60, length, this.st, feed, points, `${cw ? "CW" : "CCW"} R${r.toFixed(3)} (comp)`);
  }

  private motion(block: Block, st: State, letters: Letters, compStartup = false, compCancel = false) {
    let mode = st.motion;
    if (mode === null) {
      this.diag("warning", "NO_MOTION_MODE", "Axis move before any G00/G01/G02/G03: the FANUC power-on default G00 (rapid) was assumed.", block, false, "no_motion_mode");
      mode = st.motion = "G0";
    }
    const target = this.target(block, st, letters);
    let start = copy(st.pos);
    if (compCancel && this.comp.active) this.compSafe(block, () => this.comp.cancel());
    if (this.comp.active && (mode === "G0" || mode === "G1")) {
      let feed: number | null;
      if (mode === "G0") {
        this.checkStartup(block);
        feed = null;
      } else {
        feed = this.feedRate(block, st);
        this.cutChecks(block, st);
      }
      this.zChecks(block, st, start, target);
      if (Math.hypot(target[0] - start[0], target[1] - start[1]) < 1e-9) {
        if (Math.abs(target[2] - start[2]) > 1e-9) {
          const kind = mode === "G0" ? "rapid" : "feed";
          const z = target[2];
          const zmove = () => {
            const p = copy(this.toolPos);
            this.compLine(block, kind, p, [p[0], p[1], z], feed);
          };
          if (!this.comp.queue(zmove)) zmove();
        }
      } else {
        const el: Element = { kind: "line", motion: mode === "G0" ? "rapid" : "feed", p0: start, p1: target, block, feed, startup: compStartup, queue: [] };
        this.compSafe(block, () => this.comp.add(el, this.toolPos.slice(0, 2)));
      }
      st.pos = target;
      return;
    }
    if (mode === "G0") {
      this.checkStartup(block);
      this.zChecks(block, st, start, target);
      this.rapid(block, st, target);
      return;
    }
    const feed = this.feedRate(block, st);
    this.cutChecks(block, st);
    this.zChecks(block, st, start, target);
    if (feed > this.settings.max_feed)
      this.diag("warning", "FEED_HIGH", `Feed ${feed.toFixed(0)} mm/min exceeds the configured maximum ${this.settings.max_feed.toFixed(0)}.`, block);
    if (mode === "G1") {
      start = copy(this.toolPos);
      const length = dist(start, target);
      if (length < 1e-9) return;
      this.emit("feed", "mill", block, start, target, (length / feed) * 60, length, st, feed);
      st.pos = target;
      return;
    }
    const clockwise = mode === "G2";
    const plane = st.plane;
    const offsetLetters = ({ G17: ["I", "J"], G18: ["K", "I"], G19: ["J", "K"] } as Record<Plane, [string, string]>)[plane];
    let center: Vec3;
    let arc;
    try {
      if (letters.has("R")) {
        const r = this.value(st, letters.get("R")!, block);
        center = arcCenterFromRadius(start, target, r, clockwise, plane);
        arc = buildArc(start, target, center, clockwise, plane, this.settings.chord_tolerance, false);
      } else {
        if (!offsetLetters.some((l) => letters.has(l))) {
          if (["I", "J", "K"].some((l) => letters.has(l)))
            this.diag(
              "error",
              "ARC_PLANE",
              `Arc centre words do not match the active plane ${plane} (expects ${offsetLetters.join("/")}). Verification stopped.`,
              block,
              true,
            );
          this.diag("error", "ARC_NO_CENTER", "G02/G03 without R or I/J/K. Verification stopped.", block, true);
        }
        const offs = offsetLetters.map((l) => (letters.has(l) ? this.value(st, letters.get(l)!, block) : 0)) as [number, number];
        center = arcCenterFromOffsets(start, offs, plane);
        arc = buildArc(start, target, center, clockwise, plane, this.settings.chord_tolerance);
        if (arc.radiusError > this.settings.arc_radius_tolerance)
          this.diag(
            "error",
            "ARC_RADIUS",
            `Arc start and end radii differ by ${arc.radiusError.toFixed(4)} mm (limit ${this.settings.arc_radius_tolerance} mm). The controller would alarm. Verification stopped.`,
            block,
            true,
          );
        else if (arc.radiusError > 0.002) this.diag("warning", "ARC_RADIUS", `Arc start/end radii differ by ${arc.radiusError.toFixed(4)} mm.`, block);
      }
    } catch (e) {
      if (!(e instanceof ArcError)) throw e;
      this.diag("error", "ARC_INVALID", `${e.message}. Verification stopped.`, block, true);
      return;
    }
    if (this.comp.active) {
      if (plane !== "G17") this.diag("error", "COMP_PLANE", "Arc outside the XY plane with cutter compensation active is not supported. Verification stopped.", block, true);
      const el: Element = { kind: "arc", motion: "arc", p0: start, p1: target, block, feed, center, cw: clockwise, queue: [] };
      this.compSafe(block, () => this.comp.add(el, this.toolPos.slice(0, 2)));
      st.pos = target;
      return;
    }
    this.emit("arc", "mill", block, start, target, (arc.length / feed) * 60, arc.length, st, feed, arc.points, `${clockwise ? "CW" : "CCW"} R${arc.radius.toFixed(3)}`);
    st.pos = target;
  }

  private dwell(block: Block, st: State, letters: Letters) {
    let seconds = 0;
    if (letters.has("P")) seconds = letters.get("P")!.value / 1000;
    else if (letters.has("X")) {
      const w = letters.get("X")!;
      seconds = w.hasDecimalPoint || this.settings.decimal_mode === "calculator" ? w.value : w.value / 1000;
    }
    this.compSafe(block, () => this.comp.flush());
    this.emit("dwell", "none", block, this.toolPos, this.toolPos, seconds, 0, st, null, null, `Dwell ${fmtG(seconds)} s`);
  }

  private stops(block: Block, st: State, groups: Map<string, string>) {
    const code = groups.get("stop");
    if (!code) return;
    if (code === "M0" || code === "M1") {
      this.compSafe(block, () => this.comp.flush());
      this.emit("stop", "none", block, this.toolPos, this.toolPos, 0, 0, st, null, null, code === "M0" ? "Program stop" : "Optional stop");
    } else {
      this.compSafe(block, () => this.comp.cancel());
      st.ended = true;
      if (st.spindle_dir !== 0) st.spindle_dir = 0;
      if (st.cutter_comp !== "G40") this.diag("warning", "COMP_AT_END", "Program ends with cutter compensation still active.", block);
    }
  }

  private toolChange(block: Block, st: State) {
    if (st.selected_tool === null) this.diag("error", "M6_NO_T", "M06 without a T number selected. Verification stopped.", block, true);
    if (st.cutter_comp !== "G40") {
      this.diag("warning", "M6_COMP", "Tool change with cutter compensation active.", block);
      this.compSafe(block, () => this.comp.flush());
    }
    if (st.cycle) this.diag("warning", "M6_CYCLE", "Tool change with a canned cycle still active (no G80).", block);
    const prev = st.tool;
    st.tool = st.selected_tool;
    st.length_comp = prev !== st.tool ? false : st.length_comp;
    if (st.tool !== null) this.toolNeedsG43.add(st.tool);
    this.emit("toolchange", "none", block, st.pos, st.pos, this.settings.tool_change_time, 0, st, null, null, `T${prev !== null ? prev : "-"} -> T${st.tool}`);
    this.diag("info", "TOOL_CHANGE_POS", "Tool-change position and clearance are not checked until a machine is configured (Phase 4).", block, false, "tc_pos");
  }

  private referenceReturn(block: Block, st: State, letters: Letters) {
    const axes = [0, 1, 2].filter((i) => letters.has(AXES[i]));
    if (!axes.length) {
      this.diag("warning", "G28_NO_AXIS", "G28 without axis words does nothing.", block);
      return;
    }
    const rp = this.settings.reference_position;
    this.diag(
      "warning",
      "REFERENCE_ASSUMED",
      `G28 reference position assumed at machine X${fmtG(rp[0])} Y${fmtG(rp[1])} Z${fmtG(rp[2])}. ` +
        "Set the real position in Job Setup or the machine configuration.",
      block,
      false,
      "ref_assumed",
    );
    const sub: Letters = new Map(axes.map((i) => [AXES[i], letters.get(AXES[i])!]));
    const intermediate = this.target(block, st, sub);
    this.rapid(block, st, intermediate, "reference", "G28 intermediate point");
    const ref = copy(st.pos);
    for (const i of axes) ref[i] = rp[i];
    this.rapid(block, st, ref, "reference", "G28 reference return");
  }

  private machineMove(block: Block, st: State, letters: Letters, motionCode: string | null) {
    if (!(motionCode === null || motionCode === "G0" || motionCode === "G1"))
      this.diag("error", "G53_MOTION", "G53 is only valid with G00/G01. Verification stopped.", block, true);
    this.diag(
      "warning",
      "MACHINE_COORDS_ASSUMED",
      "G53 moves are in machine coordinates. They are only placed correctly if the work offsets in " +
        "Job Setup are the real machine values; with zero offsets, machine zero is drawn at part zero.",
      block,
      false,
      "g53",
    );
    const target = copy(st.pos);
    AXES.forEach((a, i) => {
      if (letters.has(a)) target[i] = this.value(st, letters.get(a)!, block);
    });
    this.rapid(block, st, target, "reference", "G53 machine move");
  }

  // ------------------------------------------------------------- cycles
  private updateCycleParams(block: Block, st: State, letters: Letters) {
    if (letters.has("R")) st.cycle_r = this.value(st, letters.get("R")!, block);
    if (letters.has("Z")) st.cycle_z = this.value(st, letters.get("Z")!, block);
    if (letters.has("Q")) st.cycle_q = Math.abs(this.value(st, letters.get("Q")!, block));
    if (letters.has("P")) st.cycle_p = letters.get("P")!.value / 1000;
  }

  private cycle(block: Block, st: State, letters: Letters) {
    const code = st.cycle!;
    const op = CYCLE_OPS[code] ?? "drill";
    this.checkStartup(block);
    if (st.cycle_z === null || st.cycle_r === null) this.diag("error", "CYCLE_PARAMS", `${code} without Z depth or R level. Verification stopped.`, block, true);
    if ((code === "G73" || code === "G83") && !st.cycle_q) this.diag("error", "CYCLE_NO_Q", `${code} peck drilling without Q (peck depth). Verification stopped.`, block, true);
    const feed = this.feedRate(block, st);
    if (st.spindle_dir === 0 || st.spindle_speed <= 0) this.diag("error", "SPINDLE_OFF_CUT", `${code} with the spindle stopped.`, block);
    if (code === "G84" && st.spindle_dir < 0) this.diag("error", "TAP_DIRECTION", "G84 right-hand tapping with spindle CCW (M04).", block);
    if (code === "G74" && st.spindle_dir > 0) this.diag("error", "TAP_DIRECTION", "G74 left-hand tapping with spindle CW (M03).", block);
    if (st.tool === null) this.diag("warning", "NO_TOOL", "Drilling starts without a T/M06 tool change.", block, false, "no_tool");

    let repeats = 1;
    if (letters.has("K")) repeats = Math.trunc(letters.get("K")!.value);
    else if (letters.has("L")) repeats = Math.trunc(letters.get("L")!.value);
    if (repeats <= 0) return;

    const initialZ = st.cycle_initial_z !== null ? st.cycle_initial_z : this.toWork(st, st.pos)[2];
    for (let k = 0; k < repeats; k++) {
      const work = this.toWork(st, st.pos);
      let rLevel: number;
      let bottom: number;
      if (st.distance === "G91") {
        rLevel = initialZ + st.cycle_r!;
        bottom = rLevel + st.cycle_z!;
        (["X", "Y"] as const).forEach((a, i) => {
          if (letters.has(a)) work[i] += this.value(st, letters.get(a)!, block);
        });
      } else {
        rLevel = st.cycle_r!;
        bottom = st.cycle_z!;
        (["X", "Y"] as const).forEach((a, i) => {
          if (letters.has(a)) work[i] = this.value(st, letters.get(a)!, block);
        });
      }
      if (bottom > rLevel)
        this.diag("error", "CYCLE_DEPTH", `${code}: hole bottom Z${bottom.toFixed(3)} is above the R level ${rLevel.toFixed(3)}. Verification stopped.`, block, true);
      if (rLevel > initialZ + 1e-9 && st.cycle_return === "G98") this.diag("warning", "CYCLE_R_ABOVE_INITIAL", `${code}: R level is above the initial level.`, block);
      this.rapid(block, st, this.toMachine(st, [work[0], work[1], work[2]]), "position");
      this.rapid(block, st, this.toMachine(st, [work[0], work[1], rLevel]), op);
      this.cycleBody(block, st, code, op, work, rLevel, bottom, feed);
      const retZ = st.cycle_return === "G98" ? initialZ : rLevel;
      this.rapid(block, st, this.toMachine(st, [work[0], work[1], retZ]), op);
    }
  }

  private feedTo(block: Block, st: State, target: Vec3, feed: number, op: OpKind, note: string | null = null) {
    const start = copy(this.toolPos);
    const length = dist(start, target);
    if (length < 1e-9) return;
    this.emit("feed", op, block, start, target, (length / feed) * 60, length, st, feed, null, note);
    st.pos = copy(target);
  }

  private cycleBody(block: Block, st: State, code: string, op: OpKind, work: Vec3, rLevel: number, bottom: number, feed: number) {
    const at = (z: number) => this.toMachine(st, [work[0], work[1], z]);
    if (code === "G81" || code === "G82") {
      this.feedTo(block, st, at(bottom), feed, op);
      if (code === "G82" && st.cycle_p) this.emit("dwell", op, block, this.toolPos, this.toolPos, st.cycle_p, 0, st, null, null, `Dwell ${fmtG(st.cycle_p)} s`);
    } else if (code === "G73" || code === "G83") {
      const q = st.cycle_q!;
      const d = this.dialect.peckClearanceMm;
      let depth = rLevel;
      while (depth > bottom + 1e-9) {
        const nxt = Math.max(depth - q, bottom);
        if (code === "G83" && depth < rLevel - 1e-9) this.rapid(block, st, at(depth + d), op);
        this.feedTo(block, st, at(nxt), feed, op, "peck");
        depth = nxt;
        if (depth > bottom + 1e-9) {
          if (code === "G83") this.rapid(block, st, at(rLevel), op);
          else this.rapid(block, st, at(depth + d), op);
        }
      }
    } else if (code === "G84" || code === "G74") {
      this.feedTo(block, st, at(bottom), feed, op, "tap in");
      if (st.cycle_p) this.emit("dwell", op, block, this.toolPos, this.toolPos, st.cycle_p, 0, st);
      this.feedTo(block, st, at(rLevel), feed, op, "tap out (spindle reversed)");
    } else if (code === "G85" || code === "G89") {
      this.feedTo(block, st, at(bottom), feed, op);
      if (code === "G89" && st.cycle_p) this.emit("dwell", op, block, this.toolPos, this.toolPos, st.cycle_p, 0, st);
      this.feedTo(block, st, at(rLevel), feed, op, "feed out");
    } else if (code === "G86" || code === "G76" || code === "G88") {
      this.feedTo(block, st, at(bottom), feed, op);
      if (code === "G88" && st.cycle_p) this.emit("dwell", op, block, this.toolPos, this.toolPos, st.cycle_p, 0, st);
    } else this.diag("error", "UNSUPPORTED_CODE", `${code} not implemented.`, block, true);
  }

  // ------------------------------------------------------------- summary
  private finish(st: State) {
    if (this.noDecimal.length) {
      const lines = [...new Set(this.noDecimal)].sort((a, b) => a - b);
      const sample = lines.slice(0, 8).join(", ") + (lines.length > 8 ? " ..." : "");
      const msg =
        this.settings.decimal_mode === "calculator"
          ? `${lines.length} line(s) have coordinates without a decimal point (lines ${sample}). ` +
            "They were read as whole millimetres/inches (e.g. X10 = 10 mm). On a FANUC with " +
            "parameter 3401#0 (DPI) = 0, X10 means 0.010 mm. Confirm the machine setting."
          : `${lines.length} line(s) have coordinates without a decimal point (lines ${sample}). They were read in least input increments (X10 = 0.010 mm).`;
      this.diags.push({ severity: "warning", code: "NO_DECIMAL_POINT", message: msg, line: lines[0], block: null, halt: false });
    }
    if (!st.ended && this.haltedAt === null)
      this.diags.push({ severity: "warning", code: "NO_PROGRAM_END", message: "Program has no M02/M30 end.", line: null, block: null, halt: false });
  }

  private summary(blocks: Block[], st: State): Summary {
    const mv = this.moves;
    const isCut = (m: RawMove) => m.kind === "feed" || m.kind === "arc";
    const rapidDist = sum(mv.filter((m) => m.kind === "rapid").map((m) => m.length));
    const cutDist = sum(mv.filter(isCut).map((m) => m.length));
    const tRapid = sum(mv.filter((m) => m.kind === "rapid").map((m) => m.duration));
    const tCut = sum(mv.filter(isCut).map((m) => m.duration));
    const tDwell = sum(mv.filter((m) => m.kind === "dwell").map((m) => m.duration));
    const tTc = sum(mv.filter((m) => m.kind === "toolchange").map((m) => m.duration));

    const tools = new Map<number | null, { cut_length: number; cut_time: number; first_line: number | null; ops: Set<string> }>();
    for (const m of mv) {
      let t = tools.get(m.tool);
      if (!t) tools.set(m.tool, (t = { cut_length: 0, cut_time: 0, first_line: null, ops: new Set() }));
      if (t.first_line === null) t.first_line = m.line;
      if (isCut(m)) {
        t.cut_length += m.length;
        t.cut_time += m.duration;
        t.ops.add(m.op);
      }
    }
    const toolRows = [...tools.entries()]
      .filter(([k, v]) => k !== null || v.cut_length > 0)
      .map(([k, v]) => ({ tool: k, first_line: v.first_line, cut_length: rn(v.cut_length, 2), cut_time: rn(v.cut_time, 2), operations: [...v.ops].sort() }));

    const holes: Record<string, number> = {};
    const seenHoles = new Set<string>();
    for (const m of mv) {
      if ((m.op === "drill" || m.op === "tap" || m.op === "bore") && m.kind === "feed") {
        const key = `${m.block}|${m.end[0].toFixed(4)}|${m.end[1].toFixed(4)}`;
        if (!seenHoles.has(key)) {
          seenHoles.add(key);
          holes[m.op] = (holes[m.op] ?? 0) + 1;
        }
      }
    }
    const bounds = (ms: RawMove[]) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      let any = false;
      for (const m of ms)
        for (const p of m.points ?? [m.start, m.end]) {
          any = true;
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i], p[i]);
            hi[i] = Math.max(hi[i], p[i]);
          }
        }
      return any ? { min: lo.map((v) => rn(v, 4)) as Vec3, max: hi.map((v) => rn(v, 4)) as Vec3 } : null;
    };
    const sev = { error: 0, warning: 0, info: 0 };
    for (const d of this.diags) sev[d.severity]++;
    const status = this.haltedAt !== null ? "halted" : sev.error ? "errors" : sev.warning ? "warnings" : "ok";
    const limitations = [
      "Material removal is not simulated yet (Phase 2).",
      "Tool, holder, vice and fixture geometry are not modelled yet (Phase 3).",
      "Machine travel limits and collisions are not checked yet (Phase 4).",
    ];
    if (this.compUsed)
      limitations.push(
        this.settings.cutter_comp_mode === "zero"
          ? "G41/G42 simulated with D = 0 (wear only): the program path is treated as the cutter centre."
          : "G41/G42 simulated with D = tool radius, FANUC type A start-up and intersection corners; check that the machine's D values match.",
      );
    if (this.settings.rapid_mode === "linear")
      limitations.push("Rapid moves are drawn as straight lines; set rapid mode to dog-leg if the machine uses non-interpolated rapids.");

    return {
      status,
      halted_at_block: this.haltedAt,
      halted_at_line: this.haltedAt !== null ? blocks[this.haltedAt].line : null,
      verification_complete: false,
      limitations,
      blocks_total: blocks.length,
      blocks_executed: this.executedBlocks,
      move_count: mv.length,
      rapid_count: mv.filter((m) => m.kind === "rapid").length,
      linear_count: mv.filter((m) => m.kind === "feed" && m.op === "mill").length,
      arc_count: mv.filter((m) => m.kind === "arc").length,
      rapid_distance: rn(rapidDist, 2),
      cutting_distance: rn(cutDist, 2),
      time_rapid: rn(tRapid, 2),
      time_cutting: rn(tCut, 2),
      time_dwell: rn(tDwell, 2),
      time_toolchange: rn(tTc, 2),
      time_total: rn(tRapid + tCut + tDwell + tTc, 2),
      tool_changes: mv.filter((m) => m.kind === "toolchange").length,
      tools: toolRows,
      holes,
      bounds_all: bounds(mv),
      bounds_cutting: bounds(mv.filter(isCut)),
      errors: sev.error,
      warnings: sev.warning,
      infos: sev.info,
      final_units: st.units,
    };
  }
}

function hasAxes(letters: Letters, xyOnly = false, includeArc = false): boolean {
  const keys = xyOnly ? ["X", "Y"] : AXES;
  if (keys.some((k) => letters.has(k))) return true;
  return includeArc && ["I", "J", "K", "R"].some((k) => letters.has(k));
}

export function interpret(text: string, settings: InterpreterSettings): InterpretResult {
  return new Interpreter(settings).run(text);
}
