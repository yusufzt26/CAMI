import type { Move, StockGrid, ToolInfo, Vec3 } from "../types";
import type { Timeline } from "./timeline";
import { type StockState, ToolShape, ZMap } from "./zmap";

const MAX_CHECKPOINTS = 40;
const CUTTING_KINDS = new Set(["rapid", "feed", "arc"]);

/**
 * Keeps the Z-map in step with the playback time. Moving forward applies moves
 * incrementally; moving backward restores the nearest checkpoint and replays.
 */
export class StockPlayback {
  readonly zmap: ZMap;
  private shapes = new Map<string, ToolShape>();
  private fallback: ToolShape;
  private applied = 0; // moves [0, applied) are fully applied
  private partial: { index: number; frac: number } | null = null;
  private checkpoints = new Map<number, ReturnType<ZMap["snapshot"]>>();
  private readonly interval: number;

  constructor(private timeline: Timeline, grid: StockGrid, tools: ToolInfo[], start?: StockState) {
    this.zmap = new ZMap(grid);
    if (start) this.zmap.loadStart(start);
    for (const t of tools) this.shapes.set(t.key, new ToolShape(t));
    this.fallback = new ToolShape({ key: "none", number: null, type: "flat", diameter: 10, corner_radius: 0, point_angle: 180, source: "default", description: "" });
    this.interval = Math.max(50, Math.ceil(timeline.moves.length / MAX_CHECKPOINTS));
    this.checkpoints.set(0, this.zmap.snapshot());
  }

  shapeFor(tool: number | null): ToolShape {
    return this.shapes.get(tool === null ? "none" : String(tool)) ?? this.fallback;
  }

  private applyMove(m: Move, upto?: { pos: Vec3; segment: number }) {
    if (!CUTTING_KINDS.has(m.kind)) return;
    const shape = this.shapeFor(m.tool);
    const id = m.tool ?? 0;
    const pts = m.points ?? [m.start, m.end];
    const lastSeg = upto ? upto.segment : pts.length - 2;
    for (let k = 0; k < lastSeg; k++) this.zmap.applySegment(pts[k], pts[k + 1], shape, id);
    if (upto) this.zmap.applySegment(pts[lastSeg], upto.pos, shape, id);
    else this.zmap.applySegment(pts[lastSeg], pts[lastSeg + 1], shape, id);
  }

  private rewindTo(index: number) {
    let best = 0;
    for (const k of this.checkpoints.keys()) if (k <= index && k > best) best = k;
    this.zmap.restore(this.checkpoints.get(best)!);
    this.applied = best;
    this.partial = null;
  }

  /** Bring the stock to the state at time t. */
  update(t: number) {
    const tl = this.timeline;
    if (tl.empty) return;
    const atEnd = t >= tl.total;
    const st = tl.stateAt(t)!;
    const target = atEnd ? tl.moves.length : st.index;
    const frac = atEnd ? 0 : st.frac;
    const behind =
      target < this.applied || (this.partial && this.partial.index === target && frac < this.partial.frac) || (this.partial && this.partial.index > target);
    if (behind) this.rewindTo(target);
    while (this.applied < target) {
      this.applyMove(tl.moves[this.applied]);
      this.applied++;
      if (this.applied % this.interval === 0 && !this.checkpoints.has(this.applied)) {
        this.checkpoints.set(this.applied, this.zmap.snapshot());
      }
    }
    this.partial = null;
    if (!atEnd && frac > 0) {
      this.applyMove(tl.moves[target], { pos: st.pos, segment: st.segment });
      this.partial = { index: target, frac };
    }
  }
}
