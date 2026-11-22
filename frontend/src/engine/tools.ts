/** Tool specs and tool hints read from program comments. Port of backend app/material_removal/tools.py. */
import type { ToolInfo } from "../types";
import type { Block } from "./lexer";

export const TOOL_TYPES = ["flat", "ball", "bull", "face", "drill", "spot", "reamer", "tap", "counterbore"];
const DEFAULT_POINT_ANGLE: Record<string, number> = { drill: 118, spot: 90 };

export type ToolSpec = Omit<ToolInfo, "key">;

export function makeTool(number: number | null, type = "flat", diameter = 10, corner_radius = 0, point_angle = 118, source = "default", description = ""): ToolSpec {
  return { number, type, diameter, corner_radius, point_angle, source, description };
}

export function normalised(t: ToolSpec): ToolSpec {
  const type = TOOL_TYPES.includes(t.type) ? t.type : "flat";
  const d = Math.max(Number(t.diameter), 0.01);
  let cr = Number(t.corner_radius);
  if (type === "ball") cr = d / 2;
  else if (type === "bull") cr = Math.min(Math.max(cr, 0), d / 2);
  else cr = 0;
  let angle = type in DEFAULT_POINT_ANGLE ? t.point_angle : 180;
  if (type in DEFAULT_POINT_ANGLE && !(angle > 10 && angle < 180)) angle = DEFAULT_POINT_ANGLE[type];
  return { number: t.number, type, diameter: d, corner_radius: cr, point_angle: angle, source: t.source, description: t.description };
}

const T_RE = /\bT\s*(\d{1,3})\b/;
const D_RE = /(?:\bD(?:IA)?\s*[=:]?\s*|Ø\s*|\b(?:TOOL\s*)?DIA(?:METER)?\.?\s*[=:]?\s*)(\d+(?:\.\d+)?)/;
const MM_RE = /\b(\d+(?:\.\d+)?)\s*MM\b/;
const CR_RE = /\b(?:CORNER\s*RAD(?:IUS)?|CR|RC|R)\s*[=:]?\s*(\d+(?:\.\d+)?)\b/;
const THREAD_RE = /\bM(\d+(?:\.\d+)?)(?:\s*X|\b)/;
const ANGLE_RE = /(\d{2,3})\s*(?:DEG|°)/;

const KEYWORDS: [string, string[]][] = [
  ["ball", ["BALL"]],
  ["bull", ["BULL", "TORUS", "TOROID", "CORNER R"]],
  ["face", ["FACE"]],
  ["spot", ["SPOT", "CENTRE DRILL", "CENTER DRILL", "CENTERING DRILL", "CENTRING DRILL", "C/DRILL"]],
  ["tap", ["TAP"]],
  ["reamer", ["REAM"]],
  ["counterbore", ["C'BORE", "CBORE", "COUNTERBORE", "C-BORE"]],
  ["drill", ["DRILL"]],
  ["flat", ["END MILL", "ENDMILL", "FLAT", "SLOT", "E/M", "SHOULDER"]],
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export interface Hint {
  description: string;
  type?: string;
  diameter?: number;
  corner_radius?: number;
  point_angle?: number;
}

function parseDescription(text: string): Hint | null {
  const u = text.toUpperCase();
  let kind: string | null = null;
  for (const [k, words] of KEYWORDS) {
    if (words.some((w) => new RegExp(`(?<![A-Z])${esc(w)}(?![A-Z])`).test(u))) {
      kind = k;
      break;
    }
  }
  let dia: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = D_RE.exec(u))) dia = parseFloat(m[1]);
  else if (kind === "tap" && (m = THREAD_RE.exec(u))) dia = parseFloat(m[1]);
  else if ((m = MM_RE.exec(u))) dia = parseFloat(m[1]);
  if (dia === null && kind === null) return null;
  const mcr = CR_RE.exec(u);
  const cr = mcr ? parseFloat(mcr[1]) : null;
  const out: Hint = { description: text.trim() };
  if (kind) out.type = kind;
  if (dia !== null && dia > 0) out.diameter = dia;
  if (cr !== null) {
    out.corner_radius = cr;
    if ((kind === null || kind === "flat") && cr > 0) out.type = "bull";
  }
  const ma = ANGLE_RE.exec(u);
  if (ma && (kind === "drill" || kind === "spot")) out.point_angle = parseFloat(ma[1]);
  return out;
}

/** Programs with no T word take the tool from the header comments, under the key null (see backend). */
export function toolHintsFromComments(blocks: Block[]): Map<number | null, Hint> {
  const hints = new Map<number | null, Hint>();
  if (!blocks.some((b) => b.words.some((w) => w.letter === "T"))) {
    const header: string[] = [];
    for (const b of blocks) {
      if (b.words.some((w) => "XYZ".includes(w.letter))) break;
      if (b.comment && /TOOL|DIA|CORNER/.test(b.comment.toUpperCase())) header.push(b.comment);
    }
    const info = header.length ? parseDescription(header.join(" ; ")) : null;
    if (info) {
      info.description = header.slice(0, 2).map((h) => h.trim()).join(" / ");
      hints.set(null, info);
    }
    return hints;
  }
  for (const b of blocks) {
    if (!b.comment) continue;
    const parts = b.comment.split(/\s\/\s|;/);
    const tw = b.get("T");
    const ownT = tw ? Math.trunc(tw.value) : null;
    for (const part of parts) {
      const m = T_RE.exec(part.toUpperCase());
      const number = m ? parseInt(m[1], 10) : ownT;
      if (number === null) continue;
      const body = m ? part.slice(m.index + m[0].length) : part;
      const info = parseDescription(body);
      if (info && !hints.has(number)) hints.set(number, info);
    }
  }
  return hints;
}

export interface ToolOverrideIn {
  type?: string;
  diameter?: number;
  corner_radius?: number;
  point_angle?: number;
  description?: string;
}

export function resolveTools(numbers: (number | null)[], hints: Map<number | null, Hint>, overrides: Record<string, ToolOverrideIn>): Map<number | null, ToolSpec> {
  const tools = new Map<number | null, ToolSpec>();
  for (const n of numbers) {
    const key = n === null ? "none" : String(n);
    let spec: ToolSpec;
    const o = overrides[key];
    if (o && Object.keys(o).length) {
      const t = o.type ?? "flat";
      spec = makeTool(n, t, o.diameter ?? 10, o.corner_radius ?? 0, o.point_angle ?? DEFAULT_POINT_ANGLE[t] ?? 118, "user", o.description ?? "");
    } else if (hints.has(n)) {
      const h = hints.get(n)!;
      const t = h.type ?? "flat";
      spec = makeTool(n, t, h.diameter ?? 10, h.corner_radius ?? 0, h.point_angle ?? DEFAULT_POINT_ANGLE[t] ?? 118, h.diameter !== undefined ? "comment" : "default", h.description ?? "");
    } else spec = makeTool(n);
    tools.set(n, normalised(spec));
  }
  return tools;
}
