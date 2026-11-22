import type { InterpretResponse, InterpreterSetup, ProgramMeta, StockSetup, ToolOverride } from "./types";

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

export async function uploadProgram(file: File): Promise<ProgramMeta> {
  const form = new FormData();
  form.append("file", file);
  return handle(await fetch("/api/programs", { method: "POST", body: form }));
}

export async function listPrograms(): Promise<ProgramMeta[]> {
  return handle(await fetch("/api/programs"));
}

export interface JobSetup {
  interpreter: InterpreterSetup;
  stock: StockSetup;
  tools: Record<string, ToolOverride>;
}

export async function interpretProgram(id: number, job: JobSetup): Promise<InterpretResponse> {
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
