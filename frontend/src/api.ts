import { localAdd, localInterpret, localList } from "./localStore";
import { type ProgramFile, readUpload } from "./programFiles";
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

/** Uploads a program, or every program inside a .zip. Returns them in archive order. */
export async function uploadProgram(file: File): Promise<ProgramMeta[]> {
  const files = await readUpload(file);
  if (LOCAL_MODE) return localAdd(files);
  const out: ProgramMeta[] = [];
  for (const f of files) out.push(await uploadOne(f));
  return out;
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
