import { useRef } from "react";
import type { ProgramMeta, Summary } from "../types";
import { STATUS_LABEL } from "./format";

export const ACCEPT = ".nc,.txt,.gcode,.tap,.NC,.TXT,.GCODE,.TAP";

interface Props {
  programs: ProgramMeta[];
  current: ProgramMeta | null;
  summary: Summary | null;
  busy: string | null;
  onUpload: (f: File) => void;
  onOpen: (id: number) => void;
}

export function TopBar({ programs, current, summary, busy, onUpload, onOpen }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="26" height="26">
            <path d="M9 4h14v6h-4v10l-3 7-3-7V10H9z" fill="currentColor" />
          </svg>
        </div>
        <div>
          <div className="brand-name">ZOOM TECHNOLOGIES</div>
          <div className="brand-sub">CAMI · VMC G-code Verification</div>
        </div>
      </div>

      <div className="topbar-actions">
        <button className="btn primary" onClick={() => input.current?.click()} disabled={!!busy}>
          <span aria-hidden>⤒</span> Upload G-code
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <select
          className="select"
          value={current?.id ?? ""}
          onChange={(e) => e.target.value && onOpen(Number(e.target.value))}
          disabled={!!busy || programs.length === 0}
          title="Recently uploaded programs"
        >
          <option value="">{programs.length ? "Recent programs…" : "No programs yet"}</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.filename} · {new Date(p.uploaded_at).toLocaleString()}
            </option>
          ))}
        </select>
      </div>

      <div className="topbar-file">
        {current ? (
          <>
            <span className="file-name" title={current.filename}>
              {current.filename}
            </span>
            <span className="file-meta">
              {current.line_count.toLocaleString()} lines · FANUC
            </span>
          </>
        ) : (
          <span className="file-meta">No program loaded</span>
        )}
      </div>

      {summary && (
        <div className={`status-pill status-${summary.status}`} title="Toolpath interpretation status">
          <span className="dot" />
          {STATUS_LABEL[summary.status]}
        </div>
      )}
    </header>
  );
}
