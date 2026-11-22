import { useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic, InterpretResponse, Severity } from "../types";
import { fmtDist, fmtTime } from "./format";

const ROW_H = 22;
type Tab = "code" | "diag" | "summary";

interface Props {
  result: InterpretResponse | null;
  currentBlock: number | null;
  onSeekBlock: (block: number) => void;
}

export function BottomPanel({ result, currentBlock, onSeekBlock }: Props) {
  const [tab, setTab] = useState<Tab>("code");
  const s = result?.summary;
  const diagCount = result ? result.diagnostics.filter((d) => d.severity !== "info").length : 0;

  useEffect(() => {
    if (s?.status === "halted" || s?.status === "errors") setTab("diag");
    else setTab("code");
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
      </div>
      <div className="tab-body">
        {!result ? (
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
