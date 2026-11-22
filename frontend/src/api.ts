import { localAdd, localClear, localInterpret, localList, localText } from "./localStore";
import { type ProgramFile, type StockHint, readUpload } from "./programFiles";
import type { InterpretResponse, InterpreterSetup, ProgramMeta, StockSetup, ToolOverride } from "./types";

/** Standalone preview build: everything runs in the browser, no backend. */
export const LOCAL_MODE = import.meta.env.VITE_LOCAL === "1";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function uploadOne(f: ProgramFile): Promise<ProgramMeta> {
  const form = new FormData();
  form.append("file", new File([f.text], f.name, { type: "text/plain" }));
  const meta = await handle<ProgramMeta>(await fetch("/api/programs", { method: "POST", body: form }));
  return f.source ? { ...meta, source: f.source } : meta;
}

/** Uploads a program, or every program inside a .zip (in archive order), plus any stock size found in the zip. */
export async function uploadProgram(file: File): Promise<{ metas: ProgramMeta[]; stock?: StockHint }> {
  const { files, stock } = await readUpload(file);
  if (LOCAL_MODE) return { metas: localAdd(files), stock };
  const metas: ProgramMeta[] = [];
  for (const f of files) metas.push(await uploadOne(f));
  return { metas, stock };
}

export async function listPrograms(): Promise<ProgramMeta[]> {
  if (LOCAL_MODE) return localList();
  return handle(await fetch("/api/programs"));
}

export interface JobSetup {
  interpreter: InterpreterSetup;
  stock: StockSetup;
  tools: Record<string, ToolOverride>;
}

export async function interpretProgram(id: number, job: JobSetup): Promise<InterpretResponse> {
  if (LOCAL_MODE) return localInterpret(id, job);
  const { stock } = job;
  const body = {
    ...job.interpreter,
    stock: { size: stock.size, origin: stock.origin, top_z: stock.topZ, allowance: stock.allowance, material: stock.material },
    tools: job.tools,
  };
  return handle(
    await fetch(`/api/programs/${id}/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function getProgramText(id: number): Promise<string> {
  if (LOCAL_MODE) return localText(id);
  return (await handle<{ content: string }>(await fetch(`/api/programs/${id}`))).content;
}

/** Deletes every uploaded program (and its stored results). */
export async function clearPrograms(): Promise<void> {
  if (LOCAL_MODE) return localClear();
  const res = await fetch("/api/programs", { method: "DELETE" });
  if (!res.ok) throw new Error(`Clear failed (${res.status})`);
}
