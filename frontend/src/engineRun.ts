/** Runs the in-browser engine (src/engine) with the UI's job setup. */
import type { JobSetup } from "./api";
import { defaultSettings } from "./engine/interpreter";
import { verify } from "./engine/verify";
import type { StockState } from "./sim/zmap";

export function runInBrowser(text: string, job: JobSetup, program: { id: number; filename: string }, start?: StockState) {
  const settings = { ...defaultSettings(), ...structuredClone(job.interpreter), comp_radii: new Map<number, number>() };
  return verify(text, settings, job.stock, job.tools, program, start);
}
