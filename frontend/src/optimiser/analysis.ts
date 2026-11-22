/**
 * NC Optimiser, phase 1: cutting-load analysis.
 *
 * The browser engine records, for every move, the material it removed from the
 * Z-map stock model (volume, deepest cut, XY length). Moves shorter than the
 * grid cell give noisy numbers, so engagement is averaged over windows of
 * consecutive cutting moves at least max(2 cells, D/4) long. Plunges and steep
 * ramps are analysed on their own.
 */
import type { InterpretResponse, ToolInfo } from "../types";

export type Metric = "mrr" | "ae" | "angle" | "ap" | "hex" | "feed";

export const METRICS: { key: Metric; label: string; unit: string; digits: number }[] = [
  { key: "mrr", label: "Material removal rate", unit: "cm³/min", digits: 1 },
  { key: "angle", label: "Engagement angle", unit: "°", digits: 0 },
  { key: "ae", label: "Radial width ae", unit: "% of Ø", digits: 0 },
  { key: "ap", label: "Axial depth ap", unit: "mm", digits: 2 },
  { key: "hex", label: "Chip thickness hex", unit: "mm", digits: 3 },
  { key: "feed", label: "Programmed feed", unit: "mm/min", digits: 0 },
];

/** 0 air, 1 light (<60°), 2 medium (60–120°), 3 heavy (120–170°), 4 full width / plunge. */
export const LEVELS = [
  { label: "Air (no material)", color: "#c3cad3" },
  { label: "Light  < 60°", color: "#7dd3fc" },
  { label: "Medium 60–120°", color: "#2563eb" },
  { label: "Heavy 120–170°", color: "#f59e0b" },
  { label: "Full width / plunge", color: "#c2410c" },
];

export interface Analysis {
  /** Aligned with result.moves; NaN where the move is not a cutting move. */
  values: Record<Metric, Float32Array>;
  level: Int8Array; // -1 = not a cutting move
  cutting: Uint8Array;
  plunge: Uint8Array;
  tool: ToolInfo | null;
  flutes: number;
  window: number;
  kpi: {
    cutTime: number;
    materialTime: number;
    airTime: number;
    fullTime: number;
    heavyTime: number;
    plunges: number;
    removed: number;
    maxMrr: number;
    avgMrr: number;
    maxAp: number;
    maxHex: number;
    levelTime: number[];
  };
}

export function defaultFlutes(t: ToolInfo | null): number {
  if (!t) return 4;
  if (t.type === "drill" || t.type === "spot" || t.type === "ball") return 2;
  if (t.type === "tap") return 1;
  if (t.type === "face") return Math.max(4, Math.round(t.diameter / 10));
  if (t.type === "bull" && t.diameter >= 20) return 3; // usually an indexable cutter
  return t.diameter < 3 ? 2 : 4;
}

function levelOf(angle: number, plunge: boolean): number {
  if (plunge || angle >= 170) return 4;
  if (angle >= 120) return 3;
  if (angle >= 60) return 2;
  return 1;
}

export function analyse(result: InterpretResponse, flutesFor: (t: ToolInfo | null) => number): Analysis | null {
  const L = result.load;
  if (!L) return null;
  const moves = result.moves;
  const n = moves.length;
  const g = result.stock.grid;
  const cell = Math.max(g.cx, g.cy);
  const toolByKey = new Map(result.tools.map((t) => [t.key, t]));
  const nan = () => new Float32Array(n).fill(NaN);
  const values: Record<Metric, Float32Array> = { mrr: nan(), ae: nan(), angle: nan(), ap: nan(), hex: nan(), feed: nan() };
  const level = new Int8Array(n).fill(-1);
  const cutting = new Uint8Array(n);
  const k = { cutTime: 0, materialTime: 0, airTime: 0, fullTime: 0, heavyTime: 0, plunges: 0, removed: 0, maxMrr: 0, avgMrr: 0, maxAp: 0, maxHex: 0, levelTime: [0, 0, 0, 0, 0] };
  let mainTool: ToolInfo | null = null;
  let mainCut = -1;
  const cutByTool = new Map<string, number>();
  let windowLen = 0;

  let win: number[] = [];
  let winLen = 0;
  let winKey = "";
  const flush = () => {
    if (!win.length) return;
    const m0 = moves[win[0]];
    const key = m0.tool === null ? "none" : String(m0.tool);
    const tool = toolByKey.get(key) ?? null;
    const D = tool?.diameter ?? 10;
    let removed = 0;
    let lxy = 0;
    let dur = 0;
    let ap = 0;
    let plunge = false;
    for (const i of win) {
      removed += L.removed[i];
      lxy += L.lxy[i];
      dur += moves[i].duration;
      if (L.ap[i] > ap) ap = L.ap[i];
      if (L.plunge[i]) plunge = true;
    }
    const z = Math.max(1, flutesFor(tool));
    for (const i of win) {
      const m = moves[i];
      cutting[i] = 1;
      values.feed[i] = m.feed ?? NaN;
      k.cutTime += m.duration;
      cutByTool.set(key, (cutByTool.get(key) ?? 0) + m.duration);
      if (removed <= 0) {
        level[i] = 0;
        k.airTime += m.duration;
        k.levelTime[0] += m.duration;
        continue;
      }
      const ae = plunge ? D : lxy > 1e-6 && ap > 0 ? Math.min(D, removed / (lxy * ap)) : D;
      const r = Math.min(1, ae / D);
      const angle = plunge ? 180 : r >= 1 ? 180 : (Math.acos(1 - 2 * r) * 180) / Math.PI;
      const mrr = dur > 0 ? removed / (dur / 60) / 1000 : 0;
      const S = Math.abs(m.spindle);
      const fz = S > 0 && m.feed ? m.feed / (S * z) : NaN;
      const hex = angle < 90 ? fz * Math.sin((angle * Math.PI) / 180) : fz;
      values.mrr[i] = mrr;
      values.ae[i] = r * 100;
      values.angle[i] = angle;
      values.ap[i] = ap;
      values.hex[i] = hex;
      const lv = levelOf(angle, plunge);
      level[i] = lv;
      k.levelTime[lv] += m.duration;
      k.materialTime += m.duration;
      if (lv === 4) k.fullTime += m.duration;
      if (lv >= 3) k.heavyTime += m.duration;
      if (mrr > k.maxMrr) k.maxMrr = mrr;
      if (ap > k.maxAp) k.maxAp = ap;
      if (hex > k.maxHex) k.maxHex = hex;
    }
    if (plunge && removed > 0) k.plunges++;
    k.removed += removed;
    win = [];
    winLen = 0;
  };

  for (let i = 0; i < n; i++) {
    const m = moves[i];
    const isCut = m.kind === "feed" || m.kind === "arc";
    const key = m.tool === null ? "none" : String(m.tool);
    if (!isCut || key !== winKey) flush();
    if (!isCut) continue;
    winKey = key;
    const D = toolByKey.get(key)?.diameter ?? 10;
    const W = Math.max(2 * cell, 0.25 * D);
    windowLen = W;
    if (L.plunge[i]) {
      flush();
      win.push(i);
      flush();
      continue;
    }
    win.push(i);
    winLen += L.lxy[i];
    if (winLen >= W) flush();
  }
  flush();

  for (const [key, t] of cutByTool) if (t > mainCut) [mainCut, mainTool] = [t, toolByKey.get(key) ?? null];
  k.avgMrr = k.materialTime > 0 ? (k.removed / 1000) / (k.materialTime / 60) : 0;
  return { values, level, cutting, plunge: L.plunge, tool: mainTool, flutes: flutesFor(mainTool), window: windowLen, kpi: k };
}
