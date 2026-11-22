import * as THREE from "three";
import type { ZMap } from "../sim/zmap";

/** Colours for surfaces cut by each tool. Red / yellow / green stay reserved for verification status. */
export const TOOL_PALETTE = ["#3b82f6", "#f97316", "#14b8a6", "#a855f7", "#ec4899", "#0ea5e9", "#78716c", "#6366f1"];
const STOCK_COLOR = new THREE.Color("#b7c0ca");

export function toolColor(tool: number | null): string {
  if (tool === null || tool < 0) return "#94a3b8";
  return TOOL_PALETTE[tool % TOOL_PALETTE.length];
}

/** Renders a Z-map as a solid: height-field top, side walls and bottom. */
export class StockMesh {
  readonly group = new THREE.Group();
  private top: THREE.Mesh;
  private walls: THREE.Mesh;
  private pos: Float32Array;
  private nrm: Float32Array;
  private col: Float32Array;
  private xv: Float32Array;
  private yv: Float32Array;
  private palette = TOOL_PALETTE.map((c) => new THREE.Color(c));

  constructor(private zmap: ZMap) {
    const g = zmap.grid;
    const { nx, ny } = g;
    this.xv = Float32Array.from({ length: nx }, (_, i) => (i === 0 ? g.x0 : i === nx - 1 ? g.x0 + nx * g.cx : g.x0 + (i + 0.5) * g.cx));
    this.yv = Float32Array.from({ length: ny }, (_, j) => (j === 0 ? g.y0 : j === ny - 1 ? g.y0 + ny * g.cy : g.y0 + (j + 0.5) * g.cy));
    const n = nx * ny;
    this.pos = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        this.pos[k] = this.xv[i];
        this.pos[k + 1] = this.yv[j];
      }
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let p = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx[p++] = a;
        idx[p++] = b;
        idx[p++] = d;
        idx[p++] = a;
        idx[p++] = d;
        idx[p++] = c;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("normal", new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
    this.top = new THREE.Mesh(geo, mat);
    this.top.frustumCulled = false;

    const wallMat = new THREE.MeshStandardMaterial({ color: STOCK_COLOR.clone().multiplyScalar(0.92), metalness: 0.15, roughness: 0.6, side: THREE.DoubleSide });
    this.walls = new THREE.Mesh(new THREE.BufferGeometry(), wallMat);
    this.walls.frustumCulled = false;

    const w = g.nx * g.cx;
    const h = g.ny * g.cy;
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    bottom.position.set(g.x0 + w / 2, g.y0 + h / 2, g.bottom);
    bottom.rotation.x = Math.PI;

    this.group.add(this.top, this.walls, bottom);
    this.refresh(0, nx, 0, ny);
    this.buildWalls();
  }

  dispose() {
    this.top.geometry.dispose();
    this.walls.geometry.dispose();
  }

  /** Push Z-map changes to the GPU (only the rows that changed). */
  update() {
    const d = this.zmap.dirty;
    if (!d) return;
    this.zmap.dirty = null;
    const g = this.zmap.grid;
    const j0 = Math.max(0, d.j0 - 1);
    const j1 = Math.min(g.ny, d.j1 + 1);
    this.refresh(Math.max(0, d.i0 - 1), Math.min(g.nx, d.i1 + 1), j0, j1);
    const geo = this.top.geometry;
    for (const name of ["position", "normal", "color"]) {
      const attr = geo.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(j0 * g.nx * 3, (j1 - j0) * g.nx * 3);
      attr.needsUpdate = true;
    }
    if (d.i0 <= 1 || d.j0 <= 1 || d.i1 >= g.nx - 1 || d.j1 >= g.ny - 1) this.buildWalls();
  }

  private refresh(i0: number, i1: number, j0: number, j1: number) {
    const { nx, ny, cx, cy } = this.zmap.grid;
    const H = this.zmap.height;
    const C = this.zmap.cutBy;
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const c = j * nx + i;
        const k = c * 3;
        this.pos[k + 2] = H[c];
        const hl = H[j * nx + Math.max(i - 1, 0)];
        const hr = H[j * nx + Math.min(i + 1, nx - 1)];
        const hd = H[Math.max(j - 1, 0) * nx + i];
        const hu = H[Math.min(j + 1, ny - 1) * nx + i];
        let nxv = -(hr - hl) / (2 * cx);
        let nyv = -(hu - hd) / (2 * cy);
        const len = Math.hypot(nxv, nyv, 1);
        nxv /= len;
        nyv /= len;
        this.nrm[k] = nxv;
        this.nrm[k + 1] = nyv;
        this.nrm[k + 2] = 1 / len;
        const t = C[c];
        const color = t < 0 ? STOCK_COLOR : this.palette[t % this.palette.length];
        this.col[k] = color.r;
        this.col[k + 1] = color.g;
        this.col[k + 2] = color.b;
      }
    }
  }

  private buildWalls() {
    const g = this.zmap.grid;
    const { nx, ny } = g;
    const H = this.zmap.height;
    const verts: number[] = [];
    const strip = (xs: number[], ys: number[], hs: number[]) => {
      for (let k = 0; k < xs.length - 1; k++) {
        const a = [xs[k], ys[k], hs[k]];
        const b = [xs[k + 1], ys[k + 1], hs[k + 1]];
        const a0 = [xs[k], ys[k], g.bottom];
        const b0 = [xs[k + 1], ys[k + 1], g.bottom];
        verts.push(...a0, ...b0, ...b, ...a0, ...b, ...a);
      }
    };
    const row = (j: number) => {
      const xs: number[] = [];
      const ys: number[] = [];
      const hs: number[] = [];
      for (let i = 0; i < nx; i++) {
        xs.push(this.xv[i]);
        ys.push(this.yv[j]);
        hs.push(H[j * nx + i]);
      }
      return [xs, ys, hs] as const;
    };
    const col = (i: number) => {
      const xs: number[] = [];
      const ys: number[] = [];
      const hs: number[] = [];
      for (let j = 0; j < ny; j++) {
        xs.push(this.xv[i]);
        ys.push(this.yv[j]);
        hs.push(H[j * nx + i]);
      }
      return [xs, ys, hs] as const;
    };
    strip(...row(0));
    strip(...row(ny - 1));
    strip(...col(0));
    strip(...col(nx - 1));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    this.walls.geometry.dispose();
    this.walls.geometry = geo;
  }
}
