/** Reading uploaded files: plain NC programs and .zip archives of them. */
import { unzipSync } from "fflate";

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
export function programsFromZip(name: string, data: Uint8Array): ProgramFile[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || (f.name.split("/").pop() ?? "").startsWith(".")) return false;
        const e = ext(f.name);
        return (NC_EXTENSIONS.includes(e) || e === "") && f.originalSize <= MAX_PROGRAM_BYTES;
      },
    });
  } catch {
    throw new Error(`${name} could not be opened as a zip archive.`);
  }
  const out: ProgramFile[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    const text = decode(bytes);
    if (text === null || !text.trim()) continue;
    let base = path.split("/").pop()!;
    if (!ext(base)) base += ".nc";
    out.push({ name: base, text, source: name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!out.length) throw new Error(`${name} has no G-code programs inside (looked for ${NC_EXTENSIONS.join(", ")} files).`);
  return out;
}

export async function readUpload(file: File): Promise<ProgramFile[]> {
  if (isZip(file.name)) return programsFromZip(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!NC_EXTENSIONS.includes(ext(file.name))) throw new Error(`Unsupported file type '${ext(file.name) || "none"}'. Allowed: ${NC_EXTENSIONS.join(", ")}, .zip`);
  if (file.size > MAX_PROGRAM_BYTES) throw new Error("File is larger than 25 MB");
  const text = decode(new Uint8Array(await file.arrayBuffer()));
  if (text === null) throw new Error("File looks binary, not a G-code text file");
  if (!text.trim()) throw new Error("File is empty");
  return [{ name: file.name, text }];
}
