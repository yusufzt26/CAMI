import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { StockPlayback } from "../sim/stockPlayback";
import type { StockState } from "../sim/zmap";
import type { Timeline } from "../sim/timeline";
import { ToolShape } from "../sim/zmap";
import type { Move, StockGrid, StockSetup, ToolInfo, Vec3 } from "../types";
import { StockMesh } from "./StockMesh";

export type Layer = "path" | "stock" | "tool";

export type ViewName = "iso" | "top" | "front" | "side";

/** Toolpath colours. Red / yellow / green are reserved for verification status. */
export const PATH_COLORS = {
  rapid: "#7c8794",
  mill: "#0284c7",
  hole: "#c026d3",
  reference: "#4f46e5",
} as const;

const VIEW_DIRS: Record<ViewName, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1.2, 0.9).normalize(),
  top: new THREE.Vector3(0, -0.0001, 1).normalize(),
  front: new THREE.Vector3(0, -1, 0.0001).normalize(),
  side: new THREE.Vector3(1, 0, 0.0001).normalize(),
};

function colorFor(m: Move): THREE.Color {
  if (m.op === "reference") return new THREE.Color(PATH_COLORS.reference);
  // Cycle moves (including their rapid approach/retract along the hole axis) share the hole colour,
  // otherwise the retract would paint over the feed on the same line.
  if (m.op === "drill" || m.op === "tap" || m.op === "bore") return new THREE.Color(PATH_COLORS.hole);
  if (m.kind === "rapid") return new THREE.Color(PATH_COLORS.rapid);
  return new THREE.Color(PATH_COLORS.mill);
}

export function stockBox(stock: StockSetup): { min: Vec3; max: Vec3 } {
  const [sx, sy, sz] = stock.size;
  const a = stock.allowance;
  let x0 = -sx / 2;
  let y0 = -sy / 2;
  switch (stock.origin) {
    case "top-front-left":
      x0 = 0;
      y0 = 0;
      break;
    case "top-front-right":
      x0 = -sx;
      y0 = 0;
      break;
    case "top-back-left":
      x0 = 0;
      y0 = -sy;
      break;
    case "top-back-right":
      x0 = -sx;
      y0 = -sy;
      break;
  }
  return {
    min: [x0 - a, y0 - a, stock.topZ - sz],
    max: [x0 + sx + a, y0 + sy + a, stock.topZ + a],
  };
}

/**
 * Three.js viewport: machine table, stock envelope, toolpath and tool assembly.
 * Kept independent from React so later phases can add stock-removal meshes,
 * fixtures and collision markers as further layers.
 */
export class SceneView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  // Orthographic, as in CAM verification tools: standard views have no perspective distortion.
  private camera: THREE.OrthographicCamera;
  private viewHeight = 600;
  private controls: OrbitControls;
  private resizeObs: ResizeObserver;
  private raf = 0;

  private stockGroup = new THREE.Group();
  private tableGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private toolGroup = new THREE.Group();
  private markerGroup = new THREE.Group();

  private donePath: THREE.LineSegments | null = null;
  private livePath: THREE.Line;
  private moveVertexStart: Int32Array = new Int32Array(0);
  private timeline: Timeline | null = null;
  private tools = new Map<string, ToolInfo>();
  private currentToolKey = "";
  private stockPlayback: StockPlayback | null = null;
  private stockMesh: StockMesh | null = null;
  private envelope: THREE.Mesh | null = null;
  private materialGroup = new THREE.Group();
  private stockBounds: { min: Vec3; max: Vec3 } | null = null;
  private pathBounds: THREE.Box3 | null = null;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xe6ebf0);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(400, -500, 400);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a95a3, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(300, -400, 800);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb4d0, 0.5);
    fill.position.set(-500, 300, 200);
    this.scene.add(fill);

    this.scene.add(this.tableGroup, this.stockGroup, this.materialGroup, this.pathGroup, this.markerGroup, this.toolGroup);
    this.scene.add(this.makeAxes(30));

    this.livePath = new THREE.Line(
      new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );
    this.livePath.frustumCulled = false;
    this.pathGroup.add(this.livePath);

    this.buildTool(null);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  snapshot(): string {
    return this.renderer.domElement.toDataURL("image/png");
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.applyFrustum(w / h);
  }

  private makeAxes(size: number) {
    const g = new THREE.Group();
    const axes: [Vec3, number][] = [
      [[1, 0, 0], 0xef4444],
      [[0, 1, 0], 0x22c55e],
      [[0, 0, 1], 0x3b82f6],
    ];
    for (const [d, c] of axes) {
      g.add(new THREE.ArrowHelper(new THREE.Vector3(...d), new THREE.Vector3(), size, c, size * 0.25, size * 0.12));
    }
    return g;
  }

  // ------------------------------------------------------------- stock
  setStock(stock: StockSetup) {
    this.stockGroup.clear();
    this.tableGroup.clear();
    const b = stockBox(stock);
    this.stockBounds = b;
    const size = new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const center = new THREE.Vector3((b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2);
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: 0x9db8d3,
        metalness: 0.1,
        roughness: 0.6,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    mesh.position.copy(center);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x334155 }));
    edges.position.copy(center);
    mesh.visible = !this.stockMesh;
    this.envelope = mesh;
    this.stockGroup.add(mesh, edges);

    // Machine table (generic until a machine model is configured in Phase 4).
    const tw = Math.max(800, size.x * 2.2);
    const td = Math.max(450, size.y * 2.2);
    const tableTop = b.min[2];
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(tw, td, 40),
      new THREE.MeshStandardMaterial({ color: 0xd3d9df, metalness: 0.2, roughness: 0.7 }),
    );
    table.position.set(center.x, center.y, tableTop - 20);
    this.tableGroup.add(table);
    const slotMat = new THREE.MeshStandardMaterial({ color: 0xa3adb8, roughness: 0.9 });
    const slots = 5;
    for (let i = 0; i < slots; i++) {
      const y = center.y - td / 2 + ((i + 0.5) * td) / slots;
      const slot = new THREE.Mesh(new THREE.BoxGeometry(tw, 18, 1), slotMat);
      slot.position.set(center.x, y, tableTop + 0.2);
      this.tableGroup.add(slot);
    }
  }

  // ----------------------------------------------------------- toolpath
  setProgram(timeline: Timeline | null, stock?: { grid: StockGrid; tools: ToolInfo[]; start?: StockState }) {
    this.timeline = timeline;
    this.tools = new Map((stock?.tools ?? []).map((t) => [t.key, t]));
    this.currentToolKey = "";
    this.materialGroup.clear();
    this.stockMesh?.dispose();
    this.stockMesh = null;
    this.stockPlayback = null;
    if (timeline && !timeline.empty && stock?.grid) {
      this.stockPlayback = new StockPlayback(timeline, stock.grid, stock.tools, stock.start);
      this.stockMesh = new StockMesh(this.stockPlayback.zmap);
      this.materialGroup.add(this.stockMesh.group);
    }
    if (this.envelope) this.envelope.visible = !this.stockMesh;
    for (const child of [...this.pathGroup.children]) {
      if (child !== this.livePath) {
        this.pathGroup.remove(child);
        const obj = child as THREE.LineSegments;
        obj.geometry?.dispose();
      }
    }
    this.donePath = null;
    this.pathBounds = null;
    this.markerGroup.clear();
    if (!timeline || timeline.empty) {
      this.updateLive(null, null);
      return;
    }
    const moves = timeline.moves;
    let segCount = 0;
    for (const m of moves) {
      if (m.kind === "rapid" || m.kind === "feed" || m.kind === "arc") {
        segCount += m.points ? m.points.length - 1 : 1;
      }
    }
    const pos = new Float32Array(segCount * 6);
    const col = new Float32Array(segCount * 6);
    this.moveVertexStart = new Int32Array(moves.length + 1);
    let v = 0;
    const box = new THREE.Box3();
    const tmp = new THREE.Vector3();
    moves.forEach((m, i) => {
      this.moveVertexStart[i] = v;
      if (!(m.kind === "rapid" || m.kind === "feed" || m.kind === "arc")) return;
      const c = colorFor(m);
      const pts = m.points ?? [m.start, m.end];
      for (let k = 0; k < pts.length - 1; k++) {
        for (const p of [pts[k], pts[k + 1]]) {
          pos.set(p, v * 3);
          col[v * 3] = c.r;
          col[v * 3 + 1] = c.g;
          col[v * 3 + 2] = c.b;
          box.expandByPoint(tmp.set(p[0], p[1], p[2]));
          v++;
        }
      }
    });
    this.moveVertexStart[moves.length] = v;
    this.pathBounds = box;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const future = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    // Executed path shares the vertex buffers; only its draw range differs.
    const doneGeo = new THREE.BufferGeometry();
    doneGeo.setAttribute("position", geo.getAttribute("position"));
    doneGeo.setAttribute("color", geo.getAttribute("color"));
    doneGeo.setDrawRange(0, 0);
    const done = new THREE.LineSegments(doneGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    future.frustumCulled = false;
    done.frustumCulled = false;
    this.donePath = done;
    this.pathGroup.add(future, done);
  }

  setHaltMarker(pos: Vec3 | null) {
    this.markerGroup.clear();
    if (!pos) return;
    const s = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 16), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
    s.position.set(...pos);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(7, 9, 48),
      new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    );
    ring.position.set(...pos);
    this.markerGroup.add(s, ring);
  }

  // ---------------------------------------------------------------- tool
  setLayerVisible(layer: Layer, visible: boolean) {
    const target = layer === "path" ? this.pathGroup : layer === "stock" ? this.materialGroup : this.toolGroup;
    target.visible = visible;
  }

  private buildTool(info: ToolInfo | null) {
    this.toolGroup.clear();
    const tool: ToolInfo = info ?? { key: "none", number: null, type: "flat", diameter: 10, corner_radius: 0, point_angle: 180, source: "default", description: "" };
    const d = Math.max(tool.diameter, 0.5);
    const shape = new ToolShape({ ...tool, diameter: d });
    const cutLen =
      tool.type === "face" ? 40 : tool.type === "drill" || tool.type === "tap" || tool.type === "reamer" ? Math.min(Math.max(d * 5, 40), 140) : Math.max(25, Math.min(d * 3, 80));
    const holderD = Math.max(d * 1.6, 32);
    const holderLen = 55;
    const spindleD = 110;
    const spindleLen = 90;
    const cyl = (r: number, len: number, z0: number, mat: THREE.Material, seg = 32) => {
      const g = new THREE.CylinderGeometry(r, r, len, seg);
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.z = z0 + len / 2;
      return m;
    };
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9d0d8, metalness: 0.35, roughness: 0.35, side: THREE.DoubleSide });
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x6b7684, metalness: 0.3, roughness: 0.45 });
    const spindleMat = new THREE.MeshStandardMaterial({
      color: 0x3a4250,
      metalness: 0.5,
      roughness: 0.5,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    // Cutter: lathe of the real tool profile (flat, ball, bull, drill point...).
    const prof: THREE.Vector2[] = [];
    const steps = 24;
    for (let k = 0; k <= steps; k++) {
      const r = (k / steps) * (d / 2);
      prof.push(new THREE.Vector2(r, shape.profile(r)));
    }
    prof.push(new THREE.Vector2(d / 2, cutLen));
    prof.push(new THREE.Vector2(0, cutLen));
    const lathe = new THREE.LatheGeometry(prof, 40);
    lathe.rotateX(Math.PI / 2);
    this.toolGroup.add(new THREE.Mesh(lathe, steel));
    const taper = new THREE.CylinderGeometry(holderD / 2, d / 2 + 2, 18, 32);
    taper.rotateX(Math.PI / 2);
    const taperMesh = new THREE.Mesh(taper, holderMat);
    taperMesh.position.z = cutLen + 9;
    this.toolGroup.add(taperMesh);
    this.toolGroup.add(cyl(holderD / 2, holderLen, cutLen + 18, holderMat));
    this.toolGroup.add(cyl(spindleD / 2, spindleLen, cutLen + 18 + holderLen, spindleMat, 48));
  }

  private ensureTool(tool: number | null) {
    const key = String(tool ?? "none");
    if (key === this.currentToolKey) return;
    this.currentToolKey = key;
    this.buildTool(this.tools.get(key) ?? null);
  }

  // ------------------------------------------------------------- playback
  setTime(t: number) {
    const tl = this.timeline;
    if (!tl || tl.empty) return;
    const st = tl.stateAt(t);
    if (!st) return;
    this.ensureTool(st.move.tool);
    this.toolGroup.position.set(...st.pos);
    const atEnd = t >= tl.total;
    if (this.stockPlayback && this.stockMesh) {
      this.stockPlayback.update(t);
      this.stockMesh.update();
    }
    if (this.donePath) {
      const i = st.index;
      const m = st.move;
      let count = this.moveVertexStart[i];
      if (atEnd) count = this.moveVertexStart[i + 1];
      else if (m.points) count += st.segment * 2;
      this.donePath.geometry.setDrawRange(0, count);
      const isPath = m.kind === "rapid" || m.kind === "feed" || m.kind === "arc";
      if (isPath && !atEnd) {
        const from = m.points ? m.points[st.segment] : m.start;
        this.updateLive(from, st.pos, colorFor(m));
      } else {
        this.updateLive(null, null);
      }
    }
  }

  private updateLive(a: Vec3 | null, b: Vec3 | null, color?: THREE.Color) {
    const attr = this.livePath.geometry.getAttribute("position") as THREE.BufferAttribute;
    if (!a || !b) {
      this.livePath.visible = false;
      return;
    }
    this.livePath.visible = true;
    attr.setXYZ(0, ...a);
    attr.setXYZ(1, ...b);
    attr.needsUpdate = true;
    if (color) (this.livePath.material as THREE.LineBasicMaterial).color.copy(color);
  }

  // ---------------------------------------------------------------- views
  private sceneBox(): THREE.Box3 {
    const box = new THREE.Box3();
    if (this.stockBounds) {
      box.expandByPoint(new THREE.Vector3(...this.stockBounds.min));
      box.expandByPoint(new THREE.Vector3(...this.stockBounds.max));
    }
    if (this.pathBounds && !this.pathBounds.isEmpty()) {
      // Ignore far-away reference returns when framing: focus on the cutting zone + stock.
      const pb = this.pathBounds.clone();
      if (this.stockBounds) pb.max.z = Math.min(pb.max.z, this.stockBounds.max[2] + 120);
      box.union(pb);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-100, -100, -50), new THREE.Vector3(100, 100, 50));
    return box;
  }

  private applyFrustum(aspect: number) {
    const h = this.viewHeight / 2;
    this.camera.left = -h * aspect;
    this.camera.right = h * aspect;
    this.camera.top = h;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
  }

  setView(view: ViewName) {
    const box = this.sceneBox();
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    // Fit the bounding sphere's projection, leaving a margin for the overlays.
    this.viewHeight = (2 * radius * 1.15) / Math.min(1, aspect);
    const dist = radius * 4 + 500;
    this.camera.position.copy(center).addScaledVector(VIEW_DIRS[view], dist);
    this.camera.near = 0.1;
    this.camera.far = dist * 4;
    this.camera.zoom = 1;
    this.applyFrustum(aspect);
    this.controls.target.copy(center);
    this.controls.update();
  }

  zoom(factor: number) {
    this.camera.zoom = Math.min(Math.max(this.camera.zoom / factor, 0.05), 200);
    this.camera.updateProjectionMatrix();
  }
}
