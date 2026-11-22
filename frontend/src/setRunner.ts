/**
 * Program sets: the programs of one job (e.g. every file in a zip) run in
 * order, each starting from the stock the earlier ones left. Uses the
 * in-browser engine; final stocks are cached per job setup.
 */
import type { JobSetup } from "./api";
import { runInBrowser } from "./engineRun";
import type { StockState } from "./sim/zmap";
import type { InterpretResponse, VerifyStatus } from "./types";

export interface SetRow {
  status: VerifyStatus;
  errors: number;
  warnings: number;
  rapidInStock: number;
  removed: number;
  time: number;
  tool: string;
}

export interface ProgramSetInfo {
  name: string;
  ids: number[];
  filenames: string[];
}

const TYPE_LABEL: Record<string, string> = { flat: "Flat", ball: "Ball", bull: "Bull", face: "Face", drill: "Drill", spot: "Spot", reamer: "Ream", tap: "Tap", counterbore: "C'bore" };

function rowOf(r: InterpretResponse): SetRow {
  const t = r.tools.find((x) => r.moves.some((m) => (m.kind === "feed" || m.kind === "arc") && String(m.tool ?? "none") === x.key)) ?? r.tools[0];
  const tool = t ? `${TYPE_LABEL[t.type] ?? t.type} Ø${t.diameter}${t.corner_radius && t.type === "bull" ? ` R${t.corner_radius}` : ""}` : "–";
  return {
    status: r.summary.status,
    errors: r.summary.errors,
    warnings: r.summary.warnings,
    rapidInStock: r.stock.rapid_in_stock_moves,
    removed: r.stock.removed_volume,
    time: r.summary.time_total,
    tool,
  };
}

const tick = () => new Promise((res) => setTimeout(res, 0));

export class SetRunner {
  private key = "";
  private finals = new Map<number, StockState>();
  readonly rows = new Map<number, SetRow>();

  constructor(readonly info: ProgramSetInfo) {}

  indexOf(id: number) {
    return this.info.ids.indexOf(id);
  }

  /** Cached results belong to one job setup; a changed setup starts over. */
  private sync(job: JobSetup) {
    const key = JSON.stringify(job);
    if (key !== this.key) {
      this.key = key;
      this.finals.clear();
      this.rows.clear();
    }
  }

  record(index: number, r: InterpretResponse & { finalStock: StockState }) {
    const id = this.info.ids[index];
    this.finals.set(id, r.finalStock);
    this.rows.set(id, rowOf(r));
  }

  private async compute(index: number, job: JobSetup, getText: (id: number) => Promise<string>) {
    const id = this.info.ids[index];
    const start = index > 0 ? this.finals.get(this.info.ids[index - 1]) : undefined;
    const r = runInBrowser(await getText(id), job, { id, filename: this.info.filenames[index] }, start);
    this.record(index, r);
    return r;
  }

  /** Stock that program `index` starts from; runs any earlier program not yet simulated. */
  async startFor(index: number, job: JobSetup, getText: (id: number) => Promise<string>, progress: (i: number) => void): Promise<StockState | undefined> {
    this.sync(job);
    for (let i = 0; i < index; i++) {
      if (this.finals.has(this.info.ids[i])) continue;
      progress(i);
      await tick();
      await this.compute(i, job, getText);
    }
    return index > 0 ? this.finals.get(this.info.ids[index - 1]) : undefined;
  }

  /** Simulates every program of the set (skipping those already done). */
  async runAll(job: JobSetup, getText: (id: number) => Promise<string>, progress: (i: number) => void) {
    const n = this.info.ids.length;
    await this.startFor(n, job, getText, progress);
  }

  /** Full result for one program, starting from the earlier programs' stock. */
  async run(index: number, job: JobSetup, getText: (id: number) => Promise<string>, progress: (i: number) => void) {
    await this.startFor(index, job, getText, progress);
    await tick();
    return this.compute(index, job, getText);
  }
}
