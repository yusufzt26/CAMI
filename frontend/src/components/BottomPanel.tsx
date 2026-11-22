import { useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic, InterpretResponse, Severity } from "../types";
import type { ProgramSetInfo, SetRow } from "../setRunner";
import { STATUS_LABEL, fmtDist, fmtTime } from "./format";

const ROW_H = 22;
type Tab = "code" | "diag" | "summary" | "set";

export interface ProgramSetView {
  info: ProgramSetInfo;
  rows: Map<number, SetRow>;
  version: number;
  carry: boolean;
  onCarry: (on: boolean) => void;
  onRunAll: () => void;
  onOpen: (id: number) => void;
  currentId: number | null;
  busy: boolean;
}

interface Props {
  programSet?: ProgramSetView | null;
  result: InterpretResponse | null;
  currentBlock: number | null;
  onSeekBlock: (block: number) => void;
}

export function BottomPanel({ programSet, result, currentBlock, onSeekBlock }: Props) {
  const [tab, setTab] = useState<Tab>("code");
  const s = result?.summary;
  const diagCount = result ? result.diagnostics.filter((d) => d.severity !== "info").length : 0;

  useEffect(() => {
    // Stay on the program set table while stepping through its programs.
    setTab((t) => (t === "set" ? t : s?.status === "halted" || s?.status === "errors" ? "diag" : "code"));
  }, [result, s?.status]);

  return (
    <section className="bottom">
      <div className="tabs">
        <button className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>
          G-code blocks {result && <span className="badge">{result.blocks.length}</span>}
        </button>
        <button className={tab === "diag" ? "on" : ""} onClick={() => setTab("diag")}>
          Diagnostics {result && <span className={`badge ${s && s.errors ? "err" : diagCount ? "warn" : ""}`}>{diagCount}</span>}
        </button>
        <button className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}>
          Toolpath summary
        </button>
        {programSet && (
          <button className={tab === "set" ? "on" : ""} onClick={() => setTab("set")}>
            Program set <span className="badge">{programSet.info.ids.length}</span>
          </button>
        )}
      </div>
      <div className="tab-body">
        {tab === "set" && programSet ? (
          <SetTable set={programSet} />
        ) : !result ? (
          <div className="placeholder">Program blocks, diagnostics and the toolpath summary appear here after upload.</div>
        ) : tab === "code" ? (
          <CodeList result={result} currentBlock={currentBlock} onSeekBlock={onSeekBlock} />
        ) : tab === "diag" ? (
          <DiagList diagnostics={result.diagnostics} onSeekBlock={onSeekBlock} />
        ) : (
          <SummaryView result={result} />
        )}
      </div>
    </section>
  );
}

function CodeList({ result, currentBlock, onSeekBlock }: Props & { result: InterpretResponse }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(200);
  const [follow, setFollow] = useState(true);
  const blocks = result.blocks;

  const severityByBlock = useMemo(() => {
    const rank: Record<Severity, number> = { info: 1, warning: 2, error: 3 };
    const map = new Map<number, Severity>();
    for (const d of result.diagnostics) {
      if (d.block == null) continue;
      const prev = map.get(d.block);
      if (!prev || rank[d.severity] > rank[prev]) map.set(d.block, d.severity);
    }
    return map;
  }, [result]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || currentBlock == null || !follow) return;
    const top = currentBlock * ROW_H;
    if (top < el.scrollTop + ROW_H || top > el.scrollTop + el.clientHeight - ROW_H * 2) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [currentBlock, follow]);

  const first = Math.max(0, Math.floor(scroll / ROW_H) - 10);
  const last = Math.min(blocks.length, Math.ceil((scroll + height) / ROW_H) + 10);

  return (
    <div className="code-wrap">
      <label className="follow">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow simulation
      </label>
      <div className="code" ref={ref} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: blocks.length * ROW_H, position: "relative" }}>
          {blocks.slice(first, last).map((b) => {
            const sev = severityByBlock.get(b.index);
            return (
              <div
                key={b.index}
                className={`code-row st-${b.status} ${b.index === currentBlock ? "current" : ""}`}
                style={{ top: b.index * ROW_H, height: ROW_H }}
                onClick={() => onSeekBlock(b.index)}
                title={b.status === "not_run" ? "Not simulated (verification stopped earlier)" : undefined}
              >
                <span className="ln">{b.line}</span>
                <span className={`sev ${sev ?? ""}`}>{sev === "error" ? "●" : sev === "warning" ? "▲" : sev === "info" ? "i" : ""}</span>
                <span className="txt">{highlight(b.text)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string) {
  const parts = text.split(/(\([^)]*\)|;.*$)/);
  return parts.map((p, i) => {
    if (p.startsWith("(") || p.startsWith(";")) return <span key={i} className="tok-c">{p}</span>;
    return p.split(/([GMTSFHDNO][-+]?\d+\.?\d*)/i).map((q, k) => {
      const c = q[0]?.toUpperCase();
      const cls = c === "G" ? "tok-g" : c === "M" ? "tok-m" : c === "T" || c === "H" || c === "D" ? "tok-t" : c === "F" || c === "S" ? "tok-f" : c === "N" || c === "O" ? "tok-n" : "";
      return cls && /^[A-Z][-+]?\d/i.test(q) ? (
        <span key={`${i}-${k}`} className={cls}>
          {q}
        </span>
      ) : (
        q
      );
    });
  });
}

function DiagList({ diagnostics, onSeekBlock }: { diagnostics: Diagnostic[]; onSeekBlock: (b: number) => void }) {
  const [showInfo, setShowInfo] = useState(false);
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const rows = diagnostics.filter((d) => showInfo || d.severity !== "info").sort((a, b) => rank[a.severity] - rank[b.severity] || (a.line ?? 0) - (b.line ?? 0));
  return (
    <div className="diag-wrap">
      <label className="follow">
        <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> Show notes
      </label>
      {rows.length === 0 ? (
        <div className="placeholder">No warnings or errors in the interpreted toolpath.</div>
      ) : (
        <table className="diag">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Line</th>
              <th>Code</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => (
              <tr key={i} className={`sev-${d.severity}`} onClick={() => d.block != null && onSeekBlock(d.block)}>
                <td>
                  <span className={`sev-tag ${d.severity}`}>{d.halt ? "STOP" : d.severity.toUpperCase()}</span>
                </td>
                <td className="mono">{d.line ?? "–"}</td>
                <td className="mono muted">{d.code}</td>
                <td>{d.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SummaryView({ result }: { result: InterpretResponse }) {
  const s = result.summary;
  const holes = Object.entries(s.holes);
  const b = s.bounds_cutting;
  const items: [string, string][] = [
    ["Estimated cycle time", fmtTime(s.time_total)],
    ["Cutting time", fmtTime(s.time_cutting)],
    ["Rapid time", fmtTime(s.time_rapid)],
    ["Tool change time", fmtTime(s.time_toolchange)],
    ["Tool changes", String(s.tool_changes)],
    ["Cutting distance", fmtDist(s.cutting_distance)],
    ["Rapid distance", fmtDist(s.rapid_distance)],
    ["Linear / arc moves", `${s.linear_count} / ${s.arc_count}`],
    ["Holes", holes.length ? holes.map(([k, v]) => `${v} ${k}`).join(", ") : "0"],
    ["Blocks run", `${s.blocks_executed} of ${s.blocks_total}`],
  ];
  return (
    <div className="summary">
      <div className="kpis">
        {items.map(([k, v]) => (
          <div className="kpi" key={k}>
            <div className="kpi-label">{k}</div>
            <div className="kpi-value">{v}</div>
          </div>
        ))}
      </div>
      <div className="summary-side">
        {b && (
          <div className="extent">
            <div className="kpi-label">Cutting extent (G54)</div>
            <div className="mono">
              X {b.min[0].toFixed(3)} … {b.max[0].toFixed(3)}
              <br />Y {b.min[1].toFixed(3)} … {b.max[1].toFixed(3)}
              <br />Z {b.min[2].toFixed(3)} … {b.max[2].toFixed(3)}
            </div>
          </div>
        )}
        {s.stock && (
          <div className="extent">
            <div className="kpi-label">Material removal ({s.stock.material || "stock"})</div>
            <div className="mono">
              Removed {(s.stock.removed_volume / 1000).toFixed(1)} cm³ of {(s.stock.initial_volume / 1000).toFixed(1)} cm³
              <br />
              Air cutting {s.stock.air_cutting_percent}% ({fmtTime(s.stock.time_air_cutting)})
              <br />
              Deepest point Z {s.stock.lowest_point.toFixed(3)}
              <br />
              {s.stock.removed_by_tool.map((t) => `T${t.tool ?? "?"} ${(t.volume / 1000).toFixed(1)} cm³`).join(" · ")}
            </div>
          </div>
        )}
        <div className="limits">
          <div className="kpi-label">Not yet verified</div>
          <ul>
            {s.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SetTable({ set }: { set: ProgramSetView }) {
  const done = set.info.ids.filter((id) => set.rows.has(id)).length;
  const total = set.info.ids.length;
  const flagged = set.info.ids.filter((id) => (set.rows.get(id)?.errors ?? 0) > 0).length;
  return (
    <div className="set-wrap">
      <div className="set-bar">
        <div className="set-title">
          <b>{set.info.name}</b> · {total} programs in name order · {done} simulated{done ? ` · ${flagged} with errors` : ""}
        </div>
        <label className="follow-inline" title="Each program starts from the stock the earlier programs of the set left">
          <input type="checkbox" checked={set.carry} disabled={set.busy} onChange={(e) => set.onCarry(e.target.checked)} /> Carry stock between programs
        </label>
        <button className="btn primary" disabled={set.busy || done === total || !set.carry} onClick={set.onRunAll}>
          {done === total ? "Whole set simulated" : done ? "Simulate the rest" : "Simulate whole set"}
        </button>
      </div>
      <div className="set-scroll">
        <table className="diag set-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Program</th>
              <th>Tool</th>
              <th>Status</th>
              <th className="rt">Errors</th>
              <th className="rt">Warnings</th>
              <th className="rt">Rapids in stock</th>
              <th className="rt">Removed cm³</th>
              <th className="rt">Time</th>
            </tr>
          </thead>
          <tbody>
            {set.info.ids.map((id, i) => {
              const r = set.rows.get(id);
              return (
                <tr key={id} className={id === set.currentId ? "current" : ""} onClick={() => !set.busy && set.onOpen(id)} title="Open this program">
                  <td className="mono">{i + 1}</td>
                  <td className="mono">{set.info.filenames[i]}</td>
                  <td>{r?.tool ?? ""}</td>
                  <td>{r ? <span className={`st-chip st-${r.status}`}>{STATUS_LABEL[r.status]}</span> : <span className="muted">not run</span>}</td>
                  <td className={`rt ${r?.errors ? "err" : ""}`}>{r ? r.errors : ""}</td>
                  <td className="rt">{r ? r.warnings : ""}</td>
                  <td className={`rt ${r?.rapidInStock ? "err" : ""}`}>{r ? r.rapidInStock : ""}</td>
                  <td className="rt">{r ? (r.removed / 1000).toFixed(1) : ""}</td>
                  <td className="rt mono">{r ? fmtTime(r.time) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
