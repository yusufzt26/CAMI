/**
 * Z-map (height-field) stock model, same algorithm as backend
 * app/material_removal/zmap.py. The backend is the authority for checks and
 * statistics; this copy drives the live material removal during playback.
 */
import type { StockGrid, ToolInfo, Vec3 } from "../types";

const CUT_TOLERANCE = 0.01;
const RAMP_SAMPLES = 12;

/** Stock left by earlier programs of a set (same grid). cutBy -2 = cut by an earlier program. */
export interface StockState {
  grid: StockGrid;
  height: Float32Array | Float64Array;
  cutBy: Int16Array;
}

/** cutBy value for cells cut by an earlier program in a set. */
export const CUT_EARLIER = -2;

export function sameGrid(a: StockGrid, b: StockGrid): boolean {
  return a.nx === b.nx && a.ny === b.ny && Math.abs(a.x0 - b.x0) < 1e-9 && Math.abs(a.y0 - b.y0) < 1e-9 && Math.abs(a.cx - b.cx) < 1e-12 && Math.abs(a.cy - b.cy) < 1e-12 && a.top === b.top && a.bottom === b.bottom;
}

export interface DirtyRect {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

export class ToolShape {
  readonly R: number;
  readonly flatBottom: boolean;
  private readonly kind: string;
  private readonly rc: number;
  private readonly cot: number;

  constructor(readonly info: ToolInfo) {
    this.R = info.diameter / 2;
    this.kind = info.type;
    this.rc = info.corner_radius;
    this.cot = 1 / Math.tan(((info.point_angle || 118) * Math.PI) / 360);
    this.flatBottom = !(this.kind === "ball" || (this.kind === "bull" && this.rc > 0) || this.kind === "drill" || this.kind === "spot");
  }

  /** Height of the cutting surface above the tip at radial distance r (r <= R). */
  profile(r: number): number {
    const R = this.R;
    switch (this.kind) {
      case "ball":
        return R - Math.sqrt(Math.max(R * R - r * r, 0));
      case "bull": {
        const flat = R - this.rc;
        if (r <= flat) return 0;
        const q = r - flat;
        return this.rc - Math.sqrt(Math.max(this.rc * this.rc - q * q, 0));
      }
      case "drill":
      case "spot":
        return r * this.cot;
      default:
        return 0;
    }
  }
}

export class ZMap {
  readonly height: Float32Array | Float64Array;
  /** Tool number that last cut each cell, -1 = uncut. */
  readonly cutBy: Int16Array;
  dirty: DirtyRect | null = null;
  /** Statistics of the last applySegment call (used by the in-browser verifier). */
  lastRemoved = 0;
  lastCells = 0;
  lastBelow = false;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;

  /** f64 = true gives the same precision as the Python engine (for checks); playback uses f32. */
  constructor(
    readonly grid: StockGrid,
    f64 = false,
  ) {
    const n = grid.nx * grid.ny;
    this.height = (f64 ? new Float64Array(n) : new Float32Array(n)).fill(grid.top);
    this.cutBy = new Int16Array(n).fill(-1);
    this.xs = Float64Array.from({ length: grid.nx }, (_, i) => grid.x0 + (i + 0.5) * grid.cx);
    this.ys = Float64Array.from({ length: grid.ny }, (_, j) => grid.y0 + (j + 0.5) * grid.cy);
  }

  reset() {
    this.height.fill(this.grid.top);
    this.cutBy.fill(-1);
    this.markDirty({ i0: 0, i1: this.grid.nx, j0: 0, j1: this.grid.ny });
  }

  /** Start from the stock an earlier program left; its cut cells are marked CUT_EARLIER. */
  loadStart(start: StockState) {
    if (!sameGrid(start.grid, this.grid)) throw new Error("Stock grid changed between programs of the set");
    this.height.set(start.height);
    for (let i = 0; i < this.cutBy.length; i++) this.cutBy[i] = start.cutBy[i] === -1 ? -1 : CUT_EARLIER;
    this.markDirty({ i0: 0, i1: this.grid.nx, j0: 0, j1: this.grid.ny });
  }

  /** Compact copy of the current stock to start the next program from. */
  state(): StockState {
    return { grid: this.grid, height: Float32Array.from(this.height), cutBy: this.cutBy.slice() };
  }

  snapshot(): { h: Float32Array | Float64Array; c: Int16Array } {
    return { h: this.height.slice(), c: this.cutBy.slice() };
  }

  restore(s: { h: Float32Array | Float64Array; c: Int16Array }) {
    this.height.set(s.h);
    this.cutBy.set(s.c);
    this.markDirty({ i0: 0, i1: this.grid.nx, j0: 0, j1: this.grid.ny });
  }

  private markDirty(r: DirtyRect) {
    const d = this.dirty;
    this.dirty = d ? { i0: Math.min(d.i0, r.i0), i1: Math.max(d.i1, r.i1), j0: Math.min(d.j0, r.j0), j1: Math.max(d.j1, r.j1) } : r;
  }

  applySegment(p0: Vec3, p1: Vec3, tool: ToolShape, toolId: number): boolean {
    const g = this.grid;
    const R = tool.R;
    const [x0, y0, z0] = p0;
    const [x1, y1, z1] = p1;
    const lowest = Math.min(z0, z1);
    this.lastRemoved = 0;
    this.lastCells = 0;
    this.lastBelow = false;
    if (lowest >= g.top - CUT_TOLERANCE) return false;
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - R - g.x0) / g.cx - 0.5));
    const i1 = Math.min(g.nx, Math.ceil((Math.max(x0, x1) + R - g.x0) / g.cx + 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - R - g.y0) / g.cy - 0.5));
    const j1 = Math.min(g.ny, Math.ceil((Math.max(y0, y1) + R - g.y0) / g.cy + 0.5));
    if (i0 >= i1 || j0 >= j1) return false;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const L2 = dx * dx + dy * dy;
    const L = Math.sqrt(L2);
    const R2 = R * R;
    const bottom = g.bottom;
    const h = this.height;
    let any = false;
    let inside = false;
    let removed = 0;
    let cells = 0;
    for (let j = j0; j < j1; j++) {
      const Y = this.ys[j];
      const row = j * g.nx;
      for (let i = i0; i < i1; i++) {
        const X = this.xs[i];
        let zc: number;
        if (L2 < 1e-12) {
          const r2 = (X - x0) ** 2 + (Y - y0) ** 2;
          if (r2 > R2) continue;
          zc = lowest + tool.profile(Math.sqrt(r2));
        } else {
          const t0 = ((X - x0) * dx + (Y - y0) * dy) / L2;
          const px = X - (x0 + t0 * dx);
          const py = Y - (y0 + t0 * dy);
          const d2 = px * px + py * py;
          if (d2 > R2) continue;
          const half = Math.sqrt(R2 - d2) / L;
          const lo = Math.max(t0 - half, 0);
          const hi = Math.min(t0 + half, 1);
          if (lo > hi) continue;
          if (tool.flatBottom) {
            zc = z0 + (dz >= 0 ? lo : hi) * dz;
          } else if (Math.abs(dz) < 1e-12) {
            const tc = Math.min(Math.max(t0, 0), 1);
            const r2 = (X - (x0 + tc * dx)) ** 2 + (Y - (y0 + tc * dy)) ** 2;
            if (r2 > R2) continue;
            zc = z0 + tool.profile(Math.sqrt(r2));
          } else {
            zc = Infinity;
            for (let k = 0; k < RAMP_SAMPLES; k++) {
              const ts = lo + ((hi - lo) * k) / (RAMP_SAMPLES - 1);
              const rr = Math.min(Math.sqrt(d2 + (L * (ts - t0)) ** 2), R);
              const z = z0 + ts * dz + tool.profile(rr);
              if (z < zc) zc = z;
            }
          }
        }
        inside = true;
        const nz = zc > bottom ? zc : bottom;
        const idx = row + i;
        if (nz < h[idx] - CUT_TOLERANCE) {
          removed += h[idx] - nz;
          cells++;
          h[idx] = nz;
          this.cutBy[idx] = toolId;
          any = true;
        }
      }
    }
    this.lastBelow = inside && lowest < bottom - CUT_TOLERANCE;
    this.lastRemoved = removed * g.cx * g.cy;
    this.lastCells = cells;
    if (any) this.markDirty({ i0, i1, j0, j1 });
    return any;
  }
}
