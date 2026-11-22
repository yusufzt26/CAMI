/**
 * In-browser program store and verifier for the standalone preview build
 * (VITE_LOCAL=1). Programs live in memory and, where the browser allows it,
 * in localStorage so they survive a reload.
 */
import demo from "../../samples/mould_plate_demo.nc?raw";
import unsafe from "../../samples/unsafe_examples.nc?raw";
import { defaultSettings } from "./engine/interpreter";
import { verify } from "./engine/verify";
import type { ProgramFile } from "./programFiles";
import type { InterpretResponse, ProgramMeta } from "./types";
import type { JobSetup } from "./api";

const KEY = "cami-preview-programs-v1";
const MAX_STORED_CHARS = 3_000_000;

interface Stored {
  meta: ProgramMeta;
  text: string;
}

// Loaded on first use, so the server build never touches storage.
let store: Stored[] | null = null;
let nextId = 0;
function all(): Stored[] {
  if (store === null) {
    store = load();
    nextId = store.reduce((m, p) => Math.max(m, p.meta.id), 0) + 1;
  }
  return store;
}

function make(id: number, f: ProgramFile, when = new Date()): Stored {
  return {
    meta: {
      id,
      filename: f.name,
      controller: "fanuc",
      size_bytes: new Blob([f.text]).size,
      line_count: f.text.split("\n").length,
      uploaded_at: when.toISOString(),
      last_status: null,
      source: f.source,
    },
    text: f.text,
  };
}

function load(): Stored[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const list = JSON.parse(raw) as Stored[];
      if (Array.isArray(list) && list.length) return list;
    }
  } catch {
    /* storage blocked or corrupt */
  }
  const t = Date.now();
  return [
    make(2, { name: "mould_plate_demo.nc", text: demo, source: "sample" }, new Date(t)),
    make(1, { name: "unsafe_examples.nc", text: unsafe, source: "sample" }, new Date(t - 1000)),
  ];
}

function save() {
  try {
    let total = 0;
    const keep = all().filter((p) => (total += p.text.length) <= MAX_STORED_CHARS);
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* quota or blocked: memory only */
  }
}

const sorted = () => [...all()].sort((a, b) => b.meta.uploaded_at.localeCompare(a.meta.uploaded_at) || b.meta.id - a.meta.id).map((p) => p.meta);

export function localList(): ProgramMeta[] {
  return sorted();
}

export function localAdd(files: ProgramFile[]): ProgramMeta[] {
  const existing = all();
  const now = Date.now();
  // Later files get slightly older timestamps so the list keeps archive order.
  const added = files.map((f, i) => make(nextId++, f, new Date(now - i)));
  store = [...added, ...existing];
  save();
  return added.map((p) => p.meta);
}

export async function localInterpret(id: number, job: JobSetup): Promise<InterpretResponse> {
  const p = all().find((x) => x.meta.id === id);
  if (!p) throw new Error("Program not found");
  // Let the busy indicator paint before the (synchronous) verification runs.
  await new Promise((r) => setTimeout(r, 30));
  const settings = { ...defaultSettings(), ...structuredClone(job.interpreter), comp_radii: new Map<number, number>() };
  const res = verify(p.text, settings, job.stock, job.tools, { id: p.meta.id, filename: p.meta.filename });
  p.meta = { ...p.meta, last_status: res.summary.status };
  save();
  return res;
}
