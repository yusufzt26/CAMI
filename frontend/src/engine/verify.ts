/**
 * Runs interpreter -> stock simulation in the browser and merges findings.
 * Port of backend app/verification.py and app/material_removal/simulate.py.
 */
import type { Diagnostic, InterpretResponse, Move, StockGrid, StockSetup, ToolOverride, Vec3 } from "../types";
import { type StockState, ToolShape, ZMap } from "../sim/zmap";
import { type InterpreterSettings, interpret } from "./interpreter";
import { tokenize } from "./lexer";
import { type ToolSpec, makeTool, normalised, resolveTools, toolHintsFromComments } from "./tools";

const MAX_CELLS = 160_000;
const MIN_CELL = 0.2;
const MAX_PER_CODE = 25;

/** Per-move engagement from the stock model (arrays aligned with moves). */
export interface MoveLoad {
  /** Material removed, mm³. */
  removed: Float32Array;
  /** Axial depth of cut: deepest material removed at one point, mm. */
  ap: Float32Array;
  /** Raw radial width of cut for this move alone, mm (removed / (XY length × ap)); noisy for moves shorter than the grid. */
  ae: Float32Array;
  /** XY travel, mm. */
  lxy: Float32Array;
  /** 1 = entry into material steeper than 45 degrees (plunge or steep ramp). */
  plunge: Uint8Array;
}

export function stockBox(s: StockSetup): [Vec3, Vec3] {
  const [sx, sy, sz] = s.size;
  const a = s.allowance;
  const origins: Record<string, [number, number]> = {
    "top-front-left": [0, 0],
    "top-front-right": [-sx, 0],
    "top-back-left": [0, -sy],
    "top-back-right": [-sx, -sy],
  };
  const [x0, y0] = origins[s.origin] ?? [-sx / 2, -sy / 2];
  return [
    [x0 - a, y0 - a, s.topZ - sz],
    [x0 + sx + a, y0 + sy + a, s.topZ + a],
  ];
}

export function gridForBox(lo: Vec3, hi: Vec3): StockGrid {
  const sx = hi[0] - lo[0];
  const sy = hi[1] - lo[1];
  const cell = Math.max(MIN_CELL, Math.sqrt((sx * sy) / MAX_CELLS));
  const nx = Math.max(2, Math.round(sx / cell));
  const ny = Math.max(2, Math.round(sy / cell));
  return { x0: lo[0], y0: lo[1], nx, ny, cx: sx / nx, cy: sy / ny, top: hi[2], bottom: lo[2] };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function volume(z: ZMap): number {
  let s = 0;
  const b = z.grid.bottom;
  for (let i = 0; i < z.height.length; i++) s += z.height[i] - b;
  return s * z.grid.cx * z.grid.cy;
}

function simulate(moves: Move[], stock: StockSetup, tools: Map<number | null, ToolSpec>, start?: StockState) {
  const [lo, hi] = stockBox(stock);
  const grid = gridForBox(lo, hi);
  const zm = new ZMap(grid, true);
  if (start) zm.loadStart(start);
  const initial = volume(zm);
  const diags: Diagnostic[] = [];
  const counts = new Map<string, number>();
  const flagged = new Set<string>();
  const flag = (severity: Diagnostic["severity"], code: string, message: string, m: Move) => {
    const key = `${code}|${m.block}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    const n = (counts.get(code) ?? 0) + 1;
    counts.set(code, n);
    if (n <= MAX_PER_CODE) diags.push({ severity, code, message, line: m.line, block: m.block, halt: false });
  };
  const n = moves.length;
  const load: MoveLoad = { removed: new Float32Array(n), ap: new Float32Array(n), ae: new Float32Array(n), lxy: new Float32Array(n), plunge: new Uint8Array(n) };
  const removedByTool = new Map<number | null, number>();
  let timeIn = 0;
  let timeAir = 0;
  let rapidHits = 0;
  const shapes = new Map<number | null, ToolShape>();
  const shapeFor = (t: number | null) => {
    let s = shapes.get(t);
    if (!s) {
      const spec = tools.get(t) ?? normalised(makeTool(null));
      shapes.set(t, (s = new ToolShape({ ...spec, key: "" })));
    }
    return s;
  };
  for (let mi = 0; mi < n; mi++) {
    const m = moves[mi];
    if (m.kind !== "rapid" && m.kind !== "feed" && m.kind !== "arc") continue;
    const tool = shapeFor(m.tool);
    const pts = m.points ?? [m.start, m.end];
    const toolId = m.tool ?? 0;
    let removed = 0;
    let cells = 0;
    let below = false;
    let ap = 0;
    let lxy = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      zm.applySegment(pts[i], pts[i + 1], tool, toolId);
      removed += zm.lastRemoved;
      cells += zm.lastCells;
      below = below || zm.lastBelow;
      if (zm.lastMaxDepth > ap) ap = zm.lastMaxDepth;
      lxy += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    }
    // Engagement: ap = deepest cut, ae = removed cross-section / ap (plunges count as full width).
    load.removed[mi] = removed;
    load.ap[mi] = ap;
    load.lxy[mi] = lxy;
    if (removed > 0 && ap > 0) {
      const D = tool.R * 2;
      const dz = m.end[2] - m.start[2];
      // Plunge / steep ramp into material: descending steeper than 45 degrees.
      if (dz < -0.01 && lxy < -dz) load.plunge[mi] = 1;
      // Raw per-move width; the optimiser averages it over a path window, since short moves are below the grid size.
      load.ae[mi] = lxy > 1e-6 ? Math.min(D, removed / (lxy * ap)) : D;
    }
    if (cells) removedByTool.set(m.tool, (removedByTool.get(m.tool) ?? 0) + removed);
    if (m.kind === "rapid") {
      if (cells) {
        rapidHits++;
        flag(
          "error",
          "RAPID_IN_STOCK",
          `Rapid move (G00) cuts material: about ${removed.toFixed(1)} mm³ removed by T${m.tool ?? "None"} at rapid traverse. On the machine this is a crash risk.`,
          m,
        );
      }
    } else if (cells) {
      timeIn += m.duration;
      if (!m.spindle) flag("error", "SPINDLE_OFF_IN_STOCK", "The tool cuts material with the spindle stopped.", m);
    } else timeAir += m.duration;
    if (below)
      flag(
        "warning",
        "BELOW_STOCK_BOTTOM",
        `Tool tip goes below the stock bottom (Z${grid.bottom.toFixed(3)}) over the stock. It would cut into the table, parallels or vice unless the part is raised.`,
        m,
      );
  }
  for (const [code, n] of counts)
    if (n > MAX_PER_CODE) diags.push({ severity: "info", code, message: `${n - MAX_PER_CODE} more '${code}' findings not listed.`, line: null, block: null, halt: false });
  const final = volume(zm);
  const cutTotal = timeIn + timeAir;
  let lowest = Infinity;
  for (let i = 0; i < zm.height.length; i++) if (zm.height[i] < lowest) lowest = zm.height[i];
  const stats = {
    grid,
    material: stock.material,
    initial_volume: r1(initial),
    final_volume: r1(final),
    removed_volume: r1(initial - final),
    removed_by_tool: [...removedByTool.entries()]
      .sort((a, b) => (a[0] === null ? 1 : 0) - (b[0] === null ? 1 : 0) || (a[0] ?? 0) - (b[0] ?? 0))
      .map(([tool, v]) => ({ tool, volume: r1(v) })),
    time_in_material: r2(timeIn),
    time_air_cutting: r2(timeAir),
    air_cutting_percent: cutTotal ? r1((100 * timeAir) / cutTotal) : 0,
    rapid_in_stock_moves: rapidHits,
    lowest_point: Math.round(lowest * 1e4) / 1e4,
  };
  return { grid, diags, stats, final: zm.state(), load };
}

export function verify(
  text: string,
  settings: InterpreterSettings,
  stock: StockSetup,
  overrides: Record<string, ToolOverride>,
  program: { id: number; filename: string },
  start?: StockState,
): InterpretResponse & { finalStock: StockState } {
  const blocks = tokenize(text);
  const hints = toolHintsFromComments(blocks);
  const declared = new Set<number>();
  for (const b of blocks) for (const w of b.words) if (w.letter === "T") declared.add(Math.trunc(w.value));
  for (const k of Object.keys(overrides)) if (/^\d+$/.test(k)) declared.add(parseInt(k, 10));
  settings.comp_radii = new Map();
  for (const [n, spec] of resolveTools([...declared].sort((a, b) => a - b), hints, overrides)) if (n !== null) settings.comp_radii.set(n, spec.diameter / 2);

  const result = interpret(text, settings);
  const used = [...new Set(result.moves.map((m) => m.tool))].sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0) || (a ?? 0) - (b ?? 0));
  const tools = resolveTools(used, hints, overrides);
  const extra: Diagnostic[] = [];
  const cutting = new Set(result.moves.filter((m) => m.kind === "feed" || m.kind === "arc").map((m) => m.tool));
  for (const [n, spec] of tools)
    if (spec.source === "default" && n !== null && cutting.has(n))
      extra.push({
        severity: "warning",
        code: "TOOL_ASSUMED",
        message: `T${n} has no size in the program comments: assumed Ø${String(Number(spec.diameter.toPrecision(6)))} flat end mill. Set the real tool in the tool table, or the cut material shown will be wrong.`,
        line: null,
        block: null,
        halt: false,
      });
  const sim = simulate(result.moves, stock, tools, start);
  const diagnostics = [...result.diagnostics, ...extra, ...sim.diags];
  const summary = { ...result.summary };
  const sev = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) sev[d.severity]++;
  summary.errors = sev.error;
  summary.warnings = sev.warning;
  summary.infos = sev.info;
  if (summary.status !== "halted") summary.status = sev.error ? "errors" : sev.warning ? "warnings" : "ok";
  const cell = Math.max(sim.grid.cx, sim.grid.cy);
  summary.limitations = [
    ...summary.limitations.filter((l) => !l.startsWith("Material removal")),
    `Material removal uses a ${cell.toFixed(2)} mm height grid: details smaller than this are approximated, and undercuts are not modelled.`,
  ];
  if (start) summary.limitations.push("Stock starts from what the earlier programs of the set left (same stock grid).");
  if (extra.some((d) => d.code === "TOOL_ASSUMED")) summary.limitations.push("Some tool sizes were assumed, so the simulated stock may differ from the real part.");
  summary.stock = sim.stats;
  return {
    program,
    blocks: result.blocks,
    moves: result.moves,
    diagnostics,
    summary,
    tools: [...tools.entries()].map(([n, spec]) => ({ ...spec, key: n === null ? "none" : String(n) })),
    stock: sim.stats,
    startStock: start,
    load: sim.load,
    finalStock: sim.final,
  };
}
