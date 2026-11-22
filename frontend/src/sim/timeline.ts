import type { Move, Vec3 } from "../types";

/** Minimum on-screen duration (s) for events that take no machine time. */
const MIN_EVENT_TIME: Partial<Record<Move["kind"], number>> = { stop: 0.5, dwell: 0.1 };

/**
 * Maps simulation time to machine state. Purely kinematic: knows nothing about
 * stock or collisions, which are separate engines in later phases.
 */
export class Timeline {
  readonly moves: Move[];
  readonly starts: Float64Array;
  readonly durations: Float64Array;
  readonly total: number;
  private readonly polyCum: (Float64Array | null)[];
  private readonly blockFirstMove = new Map<number, number>();

  constructor(moves: Move[]) {
    this.moves = moves;
    this.starts = new Float64Array(moves.length);
    this.durations = new Float64Array(moves.length);
    this.polyCum = new Array(moves.length).fill(null);
    let t = 0;
    moves.forEach((m, i) => {
      const d = Math.max(m.duration, MIN_EVENT_TIME[m.kind] ?? 0, 1e-4);
      this.starts[i] = t;
      this.durations[i] = d;
      t += d;
      if (m.points && m.points.length > 2) {
        const cum = new Float64Array(m.points.length);
        for (let k = 1; k < m.points.length; k++) cum[k] = cum[k - 1] + dist(m.points[k - 1], m.points[k]);
        this.polyCum[i] = cum;
      }
      if (!this.blockFirstMove.has(m.block)) this.blockFirstMove.set(m.block, i);
    });
    this.total = t;
  }

  get empty() {
    return this.moves.length === 0;
  }

  /** Index of the move active at time t (clamped). */
  indexAt(t: number): number {
    const n = this.moves.length;
    if (n === 0) return -1;
    if (t <= 0) return 0;
    if (t >= this.total) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  fractionAt(i: number, t: number): number {
    if (i < 0) return 0;
    return clamp01((t - this.starts[i]) / this.durations[i]);
  }

  /** Position along move i at fraction f, plus index of the polyline segment reached. */
  pointOn(i: number, f: number): { pos: Vec3; segment: number } {
    const m = this.moves[i];
    const cum = this.polyCum[i];
    if (!cum || !m.points) return { pos: lerp(m.start, m.end, f), segment: 0 };
    const target = f * cum[cum.length - 1];
    let k = 1;
    while (k < cum.length - 1 && cum[k] < target) k++;
    const segLen = cum[k] - cum[k - 1];
    const local = segLen > 0 ? (target - cum[k - 1]) / segLen : 1;
    return { pos: lerp(m.points[k - 1], m.points[k], local), segment: k - 1 };
  }

  stateAt(t: number) {
    const index = this.indexAt(t);
    if (index < 0) return null;
    const frac = this.fractionAt(index, t);
    const { pos, segment } = this.pointOn(index, frac);
    return { index, frac, pos, segment, move: this.moves[index] };
  }

  startOf(i: number) {
    return this.starts[i] ?? 0;
  }

  endOf(i: number) {
    return (this.starts[i] ?? 0) + (this.durations[i] ?? 0);
  }

  /** First move produced by block index (or the next block that produced one). */
  moveForBlock(block: number): number {
    const direct = this.blockFirstMove.get(block);
    if (direct !== undefined) return direct;
    for (let i = 0; i < this.moves.length; i++) if (this.moves[i].block >= block) return i;
    return this.moves.length - 1;
  }
}

function dist(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lerp(a: Vec3, b: Vec3, f: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
