import type { VerifyStatus } from "../types";

export function fmtTime(seconds: number): string {
  if (!isFinite(seconds)) return "--:--";
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function fmtNum(v: number, digits = 3): string {
  return (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits);
}

export function fmtDist(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(1)} mm`;
}

export const STATUS_LABEL: Record<VerifyStatus, string> = {
  ok: "Toolpath OK",
  warnings: "Warnings",
  errors: "Errors found",
  halted: "Verification stopped",
};
