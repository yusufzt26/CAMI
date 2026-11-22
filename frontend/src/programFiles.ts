/** Reading uploaded files: plain NC programs and .zip archives of them. */
import { unzipSync } from "fflate";
import type { StockOrigin } from "./types";

export const NC_EXTENSIONS = [".nc", ".txt", ".gcode", ".tap"];
export const MAX_PROGRAM_BYTES = 25 * 1024 * 1024;

export interface ProgramFile {
  name: string;
  text: string;
  /** Archive the program came from, if any. */
  source?: string;
}

const ext = (name: string) => {
  const base = name.split("/").pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
};

/** Stock block found next to the programs (WorkNC writes it to bruts3d.dim). */
export interface StockHint {
  size: [number, number, number];
  origin: StockOrigin;
  topZ: number;
  source: string;
}

export interface UploadContents {
  files: ProgramFile[];
  stock?: StockHint;
}

/** WorkNC bruts3d.dim: "xmin xmax / ymin ymax / zmin zmax". Only boxes that fit a part-zero preset are used. */
export function parseWorkncStock(text: string): StockHint | undefined {
  const rows = text.trim().split(/\r?\n/).slice(0, 3).map((l) => l.trim().split(/\s+/).map(Number));
  if (rows.length < 3 || rows.some((r) => r.length < 2 || r.slice(0, 2).some((v) => !Number.isFinite(v)))) return undefined;
  const [[x0, x1], [y0, y1], [z0, z1]] = rows;
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
  if (!(sx > 0 && sy > 0 && sz > 0)) return undefined;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  let origin: StockOrigin | undefined;
  if (near(x0, -x1) && near(y0, -y1)) origin = "top-center";
  else if (near(x0, 0) && near(y0, 0)) origin = "top-front-left";
  else if (near(x1, 0) && near(y0, 0)) origin = "top-front-right";
  else if (near(x0, 0) && near(y1, 0)) origin = "top-back-left";
  else if (near(x1, 0) && near(y1, 0)) origin = "top-back-right";
  if (!origin) return undefined;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { size: [r(sx), r(sy), r(sz)], origin, topZ: r(z1), source: "bruts3d.dim" };
}

export const isZip = (name: string) => ext(name) === ".zip";

function decode(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 4096).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Unpacks NC programs from a zip. Files with no extension (e.g. O1234) are taken too. */
export function programsFromZip(name: string, data: Uint8Array): UploadContents {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || (f.name.split("/").pop() ?? "").startsWith(".")) return false;
        if ((f.name.split("/").pop() ?? "").toLowerCase() === "bruts3d.dim") return f.originalSize < 4096;
        const e = ext(f.name);
        return (NC_EXTENSIONS.includes(e) || e === "") && f.originalSize <= MAX_PROGRAM_BYTES;
      },
    });
  } catch {
    throw new Error(`${name} could not be opened as a zip archive.`);
  }
  const out: ProgramFile[] = [];
  let stock: StockHint | undefined;
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.toLowerCase().endsWith("bruts3d.dim")) {
      stock ??= parseWorkncStock(new TextDecoder().decode(bytes));
      continue;
    }
    const text = decode(bytes);
    if (text === null || !text.trim()) continue;
    let base = path.split("/").pop()!;
    if (!ext(base)) base += ".nc";
    out.push({ name: base, text, source: name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!out.length) throw new Error(`${name} has no G-code programs inside (looked for ${NC_EXTENSIONS.join(", ")} files).`);
  return { files: out, stock };
}

export async function readUpload(file: File): Promise<UploadContents> {
  if (isZip(file.name)) return programsFromZip(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!NC_EXTENSIONS.includes(ext(file.name))) throw new Error(`Unsupported file type '${ext(file.name) || "none"}'. Allowed: ${NC_EXTENSIONS.join(", ")}, .zip`);
  if (file.size > MAX_PROGRAM_BYTES) throw new Error("File is larger than 25 MB");
  const text = decode(new Uint8Array(await file.arrayBuffer()));
  if (text === null) throw new Error("File looks binary, not a G-code text file");
  if (!text.trim()) throw new Error("File is empty");
  return { files: [{ name: file.name, text }] };
}
