/** Arc and rapid-path geometry. Port of backend app/gcode/geometry.py. */
import type { Vec3 } from "../types";

export type Plane = "G17" | "G18" | "G19";
export const PLANE_AXES: Record<Plane, [number, number, number]> = { G17: [0, 1, 2], G18: [2, 0, 1], G19: [1, 2, 0] };

export class ArcError extends Error {}

export interface ArcResult {
  center: Vec3;
  radius: number;
  sweep: number;
  points: Vec3[];
  length: number;
  radiusError: number;
}

export const dist = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

export function arcCenterFromOffsets(start: Vec3, offsets: [number, number], plane: Plane): Vec3 {
  const [a, b] = PLANE_AXES[plane];
  const c = [...start] as Vec3;
  c[a] = start[a] + offsets[0];
  c[b] = start[b] + offsets[1];
  return c;
}

export function arcCenterFromRadius(start: Vec3, end: Vec3, r: number, clockwise: boolean, plane: Plane, tol = 1e-3): Vec3 {
  const [a, b] = PLANE_AXES[plane];
  const dx = end[a] - start[a];
  const dy = end[b] - start[b];
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) throw new ArcError("R-format arc with identical start and end point (full circle needs I/J/K)");
  const half = d / 2;
  if (half > Math.abs(r) + tol) throw new ArcError(`Arc radius R${String(Number(Math.abs(r).toPrecision(6)))} too small for chord length ${d.toFixed(4)} mm`);
  const h = Math.sqrt(Math.max(r * r - half * half, 0));
  const mx = start[a] + dx / 2;
  const my = start[b] + dy / 2;
  const px = -dy / d;
  const py = dx / d;
  let sign = clockwise ? -1 : 1;
  if (r < 0) sign = -sign;
  const c = [...start] as Vec3;
  c[a] = mx + sign * h * px;
  c[b] = my + sign * h * py;
  return c;
}

export function buildArc(start: Vec3, end: Vec3, center: Vec3, clockwise: boolean, plane: Plane, chordTol: number, fullCircleAllowed = true): ArcResult {
  const [a, b, n] = PLANE_AXES[plane];
  const r0 = Math.hypot(start[a] - center[a], start[b] - center[b]);
  const r1 = Math.hypot(end[a] - center[a], end[b] - center[b]);
  if (r0 < 1e-9) throw new ArcError("Arc centre coincides with start point");
  const th0 = Math.atan2(start[b] - center[b], start[a] - center[a]);
  const th1 = Math.atan2(end[b] - center[b], end[a] - center[a]);
  const samePoint = Math.hypot(end[a] - start[a], end[b] - start[b]) < 1e-6;
  let sweep = th1 - th0;
  if (clockwise) {
    if (sweep >= -1e-12) sweep -= 2 * Math.PI;
    if (samePoint) sweep = -2 * Math.PI;
  } else {
    if (sweep <= 1e-12) sweep += 2 * Math.PI;
    if (samePoint) sweep = 2 * Math.PI;
  }
  if (samePoint && !fullCircleAllowed) throw new ArcError("Full circle not allowed");
  const r = r0;
  let seg: number;
  if (r <= chordTol) seg = 4;
  else {
    const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - chordTol / r)));
    seg = Math.ceil(Math.abs(sweep) / Math.max(step, 1e-6));
  }
  seg = Math.max(4, Math.min(seg, 720));
  const dn = end[n] - start[n];
  const points: Vec3[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const th = th0 + sweep * t;
    const rr = r0 + (r1 - r0) * t;
    const p: Vec3 = [0, 0, 0];
    p[a] = center[a] + rr * Math.cos(th);
    p[b] = center[b] + rr * Math.sin(th);
    p[n] = start[n] + dn * t;
    points.push(p);
  }
  points[0] = [...start] as Vec3;
  points[points.length - 1] = [...end] as Vec3;
  const length = Math.hypot(r * Math.abs(sweep), dn);
  return { center, radius: r, sweep, points, length, radiusError: Math.abs(r1 - r0) };
}

export function doglegPoints(start: Vec3, end: Vec3): Vec3[] {
  const deltas = [0, 1, 2].map((i) => end[i] - start[i]);
  const order = [...new Set(deltas.filter((d) => Math.abs(d) > 1e-9).map((d) => Math.abs(d)))].sort((x, y) => x - y);
  const points: Vec3[] = [[...start] as Vec3];
  for (const travel of order) {
    points.push([0, 1, 2].map((i) => start[i] + Math.sign(deltas[i] || 1) * Math.min(Math.abs(deltas[i]), travel)) as Vec3);
  }
  if (points.length === 1) points.push([...end] as Vec3);
  points[points.length - 1] = [...end] as Vec3;
  return points;
}

export function polylineLength(points: Vec3[]): number {
  let s = 0;
  for (let i = 0; i < points.length - 1; i++) s += dist(points[i], points[i + 1]);
  return s;
}
