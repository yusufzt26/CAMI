/** Cutter radius compensation (G41/G42), FANUC style. Port of backend app/gcode/cutter_comp.py. */
import type { Vec3 } from "../types";
import type { Block } from "./lexer";
import { buildArc } from "./geometry";

const EPS = 1e-9;
type P2 = [number, number];

export interface Element {
  kind: "line" | "arc";
  motion: "rapid" | "feed" | "arc";
  p0: Vec3;
  p1: Vec3;
  block: Block;
  feed: number | null;
  center?: Vec3;
  cw?: boolean;
  startup?: boolean;
  q0?: P2;
  queue: (() => void)[];
}

export class CompError extends Error {}

const unit = (x: number, y: number): P2 => {
  const n = Math.hypot(x, y);
  return n > EPS ? [x / n, y / n] : [0, 0];
};

export function tangent(el: Element, atEnd: boolean): P2 {
  if (el.kind === "line") return unit(el.p1[0] - el.p0[0], el.p1[1] - el.p0[1]);
  const p = atEnd ? el.p1 : el.p0;
  const c = el.center!;
  const rx = p[0] - c[0];
  const ry = p[1] - c[1];
  return el.cw ? unit(ry, -rx) : unit(-ry, rx);
}

const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];

function lineCircle(p: P2, d: P2, c: readonly number[], r: number): P2[] {
  const fx = p[0] - c[0];
  const fy = p[1] - c[1];
  const a = d[0] ** 2 + d[1] ** 2;
  const b = 2 * (fx * d[0] + fy * d[1]);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < -1e-9 || a < EPS) return [];
  const s = Math.sqrt(Math.max(disc, 0));
  return [(-b - s) / (2 * a), (-b + s) / (2 * a)].map((t) => [p[0] + t * d[0], p[1] + t * d[1]] as P2);
}

function circleCircle(c1: readonly number[], r1: number, c2: readonly number[], r2: number): P2[] {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(r1 * r1 - a * a, 0));
  const mx = c1[0] + (a * dx) / d;
  const my = c1[1] + (a * dy) / d;
  return [
    [mx + (h * dy) / d, my - (h * dx) / d],
    [mx - (h * dy) / d, my + (h * dx) / d],
  ];
}

export type EmitLine = (block: Block, kind: string, start: Vec3, end: Vec3, feed: number | null) => void;
export type EmitArc = (block: Block, start: Vec3, end: Vec3, center: Vec3, cw: boolean, feed: number | null, points: Vec3[], length: number) => void;

export class CutterComp {
  side = 0;
  radius = 0;
  pending: Element | null = null;
  warnings: [Block, string, string][] = [];

  constructor(
    private emitLine: EmitLine,
    private emitArc: EmitArc,
    private tol: number,
  ) {}

  normal(el: Element, atEnd: boolean): P2 {
    const t = tangent(el, atEnd);
    return [-t[1] * this.side, t[0] * this.side];
  }

  offsetRadius(el: Element): number {
    const c = el.center!;
    const ra = Math.hypot(el.p0[0] - c[0], el.p0[1] - c[1]);
    const centerLeft = !el.cw;
    const inside = centerLeft === this.side > 0;
    const r = inside ? ra - this.radius : ra + this.radius;
    if (r <= 1e-6)
      throw new CompError(`Arc radius ${ra.toFixed(3)} mm is smaller than the cutter radius ${this.radius.toFixed(3)} mm on the inside of the arc (controller alarm).`);
    return r;
  }

  private offsetPoint(p: readonly number[], n: P2): P2 {
    return [p[0] + n[0] * this.radius, p[1] + n[1] * this.radius];
  }

  private intersection(a: Element, b: Element, near: P2): P2[] | null {
    let pts: P2[];
    if (a.kind === "line" && b.kind === "line") {
      const pa = this.offsetPoint(a.p1, this.normal(a, true));
      const pb = this.offsetPoint(b.p0, this.normal(b, false));
      const da = tangent(a, true);
      const db = tangent(b, false);
      const den = cross(da, db);
      if (Math.abs(den) < 1e-12) return null;
      const t = cross([pb[0] - pa[0], pb[1] - pa[1]], db) / den;
      return [[pa[0] + t * da[0], pa[1] + t * da[1]]];
    }
    if (a.kind === "line" || b.kind === "line") {
      const [line, arc] = a.kind === "line" ? [a, b] : [b, a];
      const pl = this.offsetPoint(line.p0, this.normal(line, false));
      pts = lineCircle(pl, tangent(line, false), arc.center!, this.offsetRadius(arc));
    } else {
      pts = circleCircle(a.center!, this.offsetRadius(a), b.center!, this.offsetRadius(b));
    }
    if (!pts.length) return null;
    let best = pts[0];
    for (const p of pts) if (Math.hypot(p[0] - near[0], p[1] - near[1]) < Math.hypot(best[0] - near[0], best[1] - near[1])) best = p;
    return [best];
  }

  engage(side: number, radius: number) {
    this.side = side;
    this.radius = radius;
  }

  get active(): boolean {
    return this.side !== 0;
  }

  add(el: Element, actualXY: readonly number[]) {
    if (this.pending === null) {
      el.q0 = [actualXY[0], actualXY[1]];
      if (!el.startup) {
        el.q0 = this.offsetPoint(el.p0, this.normal(el, false));
        if (Math.hypot(el.q0[0] - actualXY[0], el.q0[1] - actualXY[1]) > 1e-6)
          this.emitLineTo(el.block, el.motion !== "arc" ? el.motion : "feed", [actualXY[0], actualXY[1]], el.q0, el.p0[2], el.p0[2], el.feed);
      }
      this.pending = el;
      return;
    }
    const a = this.pending;
    if (a.startup) {
      const q = this.offsetPoint(a.p1, this.normal(el, false));
      this.emitElement(a, q);
      el.q0 = q;
    } else {
      const nA = this.normal(a, true);
      const nB = this.normal(el, false);
      const corner = a.p1;
      if (Math.hypot(nA[0] - nB[0], nA[1] - nB[1]) < 1e-7) {
        const q = this.offsetPoint(corner, nA);
        this.emitElement(a, q);
        el.q0 = q;
      } else {
        const cr = cross(tangent(a, true), tangent(el, false));
        const inner = cr * this.side > 1e-12;
        if (inner) {
          const near: P2 = [corner[0] + ((nA[0] + nB[0]) * this.radius) / 2, corner[1] + ((nA[1] + nB[1]) * this.radius) / 2];
          const pts = this.intersection(a, el, near);
          if (!pts) throw new CompError("No intersection between the offset paths at an inside corner (cutter radius too large).");
          const q = pts[0];
          this.emitElement(a, q);
          el.q0 = q;
        } else {
          const qa = this.offsetPoint(corner, nA);
          const qb = this.offsetPoint(corner, nB);
          this.emitElement(a, qa, false);
          const cw = Math.abs(cr) > 1e-12 ? cr < 0 : this.side > 0;
          this.emitCorner(a.block, qa, qb, corner, cw, a.p1[2], a.feed, a.motion);
          CutterComp.runQueue(a);
          el.q0 = qb;
        }
      }
    }
    this.pending = el;
  }

  queue(fn: () => void): boolean {
    if (this.pending === null) return false;
    this.pending.queue.push(fn);
    return true;
  }

  flush() {
    const a = this.pending;
    if (a === null) return;
    this.pending = null;
    this.emitElement(a, this.offsetPoint(a.p1, this.normal(a, true)));
  }

  cancel() {
    this.flush();
    this.side = 0;
  }

  private emitElement(el: Element, q1: P2, runQueue = true) {
    const q0 = el.q0!;
    if (el.kind === "line" || el.startup) {
      if (el.kind === "line" && !el.startup) {
        const prog = [el.p1[0] - el.p0[0], el.p1[1] - el.p0[1]];
        const comp = [q1[0] - q0[0], q1[1] - q0[1]];
        if (prog[0] * comp[0] + prog[1] * comp[1] < -1e-9)
          this.warnings.push([el.block, "COMP_INTERFERENCE", "Cutter compensation reverses this move: the element is shorter than the cutter radius allows (overcut / gouge)."]);
      }
      this.emitLineTo(el.block, el.motion !== "arc" ? el.motion : "feed", q0, q1, el.p0[2], el.p1[2], el.feed);
    } else {
      const r = this.offsetRadius(el);
      const c = el.center!;
      const start: Vec3 = [q0[0], q0[1], el.p0[2]];
      const end: Vec3 = [q1[0], q1[1], el.p1[2]];
      const center: Vec3 = [c[0], c[1], el.p0[2]];
      for (const p of [start, end]) {
        const vx = p[0] - center[0];
        const vy = p[1] - center[1];
        const d = Math.hypot(vx, vy);
        if (d > EPS) {
          p[0] = center[0] + (vx / d) * r;
          p[1] = center[1] + (vy / d) * r;
        }
      }
      const arc = buildArc(start, end, center, !!el.cw, "G17", this.tol);
      this.emitArc(el.block, start, end, center, !!el.cw, el.feed, arc.points, arc.length);
    }
    if (runQueue) CutterComp.runQueue(el);
  }

  private static runQueue(el: Element) {
    const queued = el.queue;
    el.queue = [];
    for (const fn of queued) fn();
  }

  private emitLineTo(block: Block, kind: string, q0: P2, q1: P2, z0: number, z1: number, feed: number | null) {
    this.emitLine(block, kind, [q0[0], q0[1], z0], [q1[0], q1[1], z1], feed);
  }

  private emitCorner(block: Block, qa: P2, qb: P2, corner: Vec3, cw: boolean, z: number, feed: number | null, motion: string) {
    const start: Vec3 = [qa[0], qa[1], z];
    const end: Vec3 = [qb[0], qb[1], z];
    const center: Vec3 = [corner[0], corner[1], z];
    if (motion === "rapid") {
      this.emitLine(block, "rapid", start, end, feed);
      return;
    }
    const arc = buildArc(start, end, center, cw, "G17", this.tol, false);
    this.emitArc(block, start, end, center, cw, feed, arc.points, arc.length);
  }
}
