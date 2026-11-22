import { useEffect, useMemo, useRef, useState } from "react";
import type { Timeline } from "../sim/timeline";
import type { InterpretResponse, ToolInfo } from "../types";
import { fmtTime } from "../components/format";
import { type Analysis, LEVELS, METRICS, type Metric, analyse, defaultFlutes } from "./analysis";
import { FeedPanel } from "./FeedPanel";
import type { InterpreterSettings } from "../engine/interpreter";

interface Props {
  result: InterpretResponse | null;
  timeline: Timeline | null;
  busy: string | null;
  error: string | null;
  loadColors: boolean;
  onLoadColors: (on: boolean, analysis: Analysis | null) => void;
  onShowInSimulator: (moveIndex: number) => void;
  getText: () => Promise<string>;
  interpSettings: () => InterpreterSettings;
}

const TYPE_LABEL: Record<string, string> = { flat: "Flat end mill", ball: "Ball nose", bull: "Bull nose", face: "Face mill", drill: "Drill", spot: "Spot drill", reamer: "Reamer", tap: "Tap", counterbore: "Counterbore" };

export function OptimiserView({ result, timeline, busy, error, loadColors, onLoadColors, onShowInSimulator, getText, interpSettings }: Props) {
  const [metric, setMetric] = useState<Metric>("mrr");
  const [flutes, setFlutes] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<number | null>(null);

  const flutesFor = (t: ToolInfo | null) => (t && flutes[t.key]) || defaultFlutes(t);
  const analysis = useMemo(() => (result ? analyse(result, flutesFor) : null), [result, flutes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSelected(null), [result]);
  useEffect(() => {
    if (loadColors) onLoadColors(true, analysis);
  }, [analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!result || !timeline) {
    return (
      <div className="opt-empty">
        {busy ? (
          <div className="busy-inline">
            <div className="spinner" /> {busy}
          </div>
        ) : (
          <>
            <h2>NC Optimiser</h2>
            <p>Open a program in the CAMI Simulator tab first. The optimiser analyses the cutting load of the program that is loaded there.</p>
            {error && <p className="err-text">{error}</p>}
          </>
        )}
      </div>
    );
  }
  if (!analysis) {
    return (
      <div className="opt-empty">
        <div className="busy-inline">
          <div className="spinner" /> {busy ?? "Analysing cutting load…"}
        </div>
      </div>
    );
  }

  const k = analysis.kpi;
  const t = analysis.tool;
  const def = METRICS.find((m) => m.key === metric)!;
  const halted = result.summary.status === "halted";
  const pct = (a: number) => (k.cutTime > 0 ? `${((100 * a) / k.cutTime).toFixed(0)}%` : "–");

  return (
    <div className="opt">
      <section className="opt-head card">
        <div className="opt-title">
          <div className="opt-kicker">Cutting load analysis</div>
          <h2 className="mono">{result.program.filename}</h2>
          <div className="muted">
            {result.startStock ? "Stock carried over from the earlier programs of the set" : "Starting from the raw stock block"} · grid {Math.max(result.stock.grid.cx, result.stock.grid.cy).toFixed(2)} mm ·
            engagement averaged over {analysis.window.toFixed(1)} mm of path
          </div>
        </div>
        {t && (
          <div className="opt-tool">
            <div>
              <b>{TYPE_LABEL[t.type] ?? t.type}</b> Ø{t.diameter}
              {t.corner_radius ? ` R${t.corner_radius}` : ""}
              <span className="muted"> · {t.source === "default" ? "size assumed" : t.source === "user" ? "set by you" : "from program comment"}</span>
            </div>
            <label className="opt-flutes">
              Flutes / inserts
              <input
                type="number"
                min={1}
                max={20}
                value={flutesFor(t)}
                onChange={(e) => setFlutes((f) => ({ ...f, [t.key]: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }))}
              />
              {!flutes[t.key] && <span className="muted">assumed</span>}
            </label>
          </div>
        )}
      </section>

      {halted && <div className="opt-warn">Verification stopped at line {result.summary.halted_at_line}. Only the part of the program before that line is analysed.</div>}

      <section className="kpis">
        <Kpi label="Cutting time (G01/G02/G03)" value={fmtTime(k.cutTime)} />
        <Kpi label="In material" value={fmtTime(k.materialTime)} sub={pct(k.materialTime)} />
        <Kpi label="Air cutting" value={fmtTime(k.airTime)} sub={pct(k.airTime)} tone={k.airTime > 0.25 * k.cutTime ? "warn" : undefined} />
        <Kpi label="Full width / plunge" value={fmtTime(k.fullTime)} sub={`${pct(k.fullTime)} · ${k.plunges} plunges`} tone={k.fullTime > 0.2 * k.materialTime ? "hot" : undefined} />
        <Kpi label="Max removal rate" value={`${k.maxMrr.toFixed(1)}`} sub={`cm³/min · avg ${k.avgMrr.toFixed(1)}`} />
        <Kpi label="Max axial depth ap" value={`${k.maxAp.toFixed(2)} mm`} sub={`removed ${(k.removed / 1000).toFixed(1)} cm³`} />
        <Kpi label="Max chip thickness" value={Number.isFinite(k.maxHex) && k.maxHex > 0 ? `${k.maxHex.toFixed(3)} mm` : "–"} sub={`with ${analysis.flutes} flutes`} />
      </section>

      <section className="card opt-chart">
        <div className="opt-chart-head">
          <select className="select" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label} ({m.unit})
              </option>
            ))}
          </select>
          <div className="opt-legend">
            {LEVELS.map((l, i) => (
              <span key={i}>
                <i style={{ background: l.color }} />
                {l.label}
                <b>{fmtTime(k.levelTime[i])}</b>
              </span>
            ))}
          </div>
          <label className="follow-inline" title="Colour the 3D toolpath in the CAMI Simulator tab by engagement">
            <input type="checkbox" checked={loadColors} onChange={(e) => onLoadColors(e.target.checked, analysis)} /> Colour toolpath by load
          </label>
        </div>
        <LoadChart analysis={analysis} timeline={timeline} metric={metric} digits={def.digits} unit={def.unit} selected={selected} onSelect={setSelected} />
        {selected !== null && <MoveDetail i={selected} result={result} analysis={analysis} onShow={() => onShowInSimulator(selected)} />}
      </section>

      <FeedPanel
        result={result}
        analysis={analysis}
        timeline={timeline}
        getText={getText}
        settings={interpSettings}
        onSelect={(i) => {
          setSelected(i);
          document.querySelector(".opt-chart")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      />

      <section className="opt-grid">
        <Heaviest result={result} analysis={analysis} metric={metric} onSelect={setSelected} selected={selected} />
        <div className="card opt-notes">
          <h3>How to read this</h3>
          <ul>
            <li>
              <b>Engagement angle</b> is the arc of the cutter in contact with material: 180° is a full-width slot or plunge, which is where feeds usually need to drop.
            </li>
            <li>
              <b>Air cutting</b> is feed moves that remove nothing from the stock model. Moves that remove less than 0.01 mm, such as spring passes, also count as air here.
            </li>
            <li>
              <b>Chip thickness</b> uses F ÷ (S × flutes), thinned for engagement under 90°. Set the real flute or insert count above.
            </li>
            <li>The stock model has a {Math.max(result.stock.grid.cx, result.stock.grid.cy).toFixed(2)} mm grid, so engagement on short finishing moves is an average, not an exact value.</li>
            <li>Feed optimisation changes F words only. Positions, arcs, tools and spindle speeds are never changed, and the result is checked by interpreting it again.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "hot" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function LoadChart({
  analysis,
  timeline,
  metric,
  digits,
  unit,
  selected,
  onSelect,
}: {
  analysis: Analysis;
  timeline: Timeline;
  metric: Metric;
  digits: number;
  unit: string;
  selected: number | null;
  onSelect: (i: number | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const H = 220;
  const PAD = { l: 52, r: 12, t: 10, b: 24 };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vals = analysis.values[metric];
  const max = useMemo(() => {
    let m = 0;
    for (let i = 0; i < vals.length; i++) if (vals[i] > m) m = vals[i];
    return m > 0 ? m * 1.08 : 1;
  }, [vals]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);
    const pw = width - PAD.l - PAD.r;
    const ph = H - PAD.t - PAD.b;
    const total = timeline.total || 1;
    // grid + axis labels
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#7a8594";
    ctx.strokeStyle = "#e3e8ee";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = PAD.t + ph - (g / 4) * ph;
      ctx.beginPath();
      ctx.moveTo(PAD.l, Math.round(y) + 0.5);
      ctx.lineTo(PAD.l + pw, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(((max * g) / 4).toFixed(metric === "hex" ? 3 : metric === "ap" ? 1 : 0), PAD.l - 6, y + 4);
    }
    ctx.textAlign = "center";
    for (let g = 0; g <= 6; g++) ctx.fillText(fmtTime((total * g) / 6), PAD.l + (pw * g) / 6, H - 6);
    // bars: per pixel column, the largest value and the level of that move
    const colVal = new Float32Array(Math.ceil(pw)).fill(-1);
    const colLvl = new Int8Array(Math.ceil(pw)).fill(-1);
    const moves = timeline.moves;
    for (let i = 0; i < moves.length; i++) {
      const lv = analysis.level[i];
      if (lv < 0) continue;
      const x0 = Math.floor((timeline.startOf(i) / total) * pw);
      const x1 = Math.max(x0, Math.min(Math.ceil(pw) - 1, Math.floor((timeline.endOf(i) / total) * pw)));
      const v = Number.isFinite(vals[i]) ? vals[i] : 0;
      for (let x = x0; x <= x1; x++) {
        if (v > colVal[x] || (v === colVal[x] && lv > colLvl[x])) {
          colVal[x] = v;
          colLvl[x] = lv;
        }
      }
    }
    for (let x = 0; x < colVal.length; x++) {
      if (colLvl[x] < 0) continue;
      const v = colVal[x];
      const h = colLvl[x] === 0 ? 3 : Math.max(2, (v / max) * ph);
      ctx.fillStyle = LEVELS[colLvl[x]].color;
      ctx.fillRect(PAD.l + x, PAD.t + ph - h, 1, h);
    }
    const mark = (i: number, color: string) => {
      const x = PAD.l + ((timeline.startOf(i) + timeline.endOf(i)) / 2 / total) * pw;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, PAD.t);
      ctx.lineTo(Math.round(x) + 0.5, PAD.t + ph);
      ctx.stroke();
    };
    if (selected !== null) mark(selected, "#0f172a");
    if (hover) mark(hover.i, "#64748b");
  }, [analysis, timeline, metric, vals, max, width, selected, hover]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (clientX: number): number | null => {
    const c = canvas.current;
    if (!c) return null;
    const x = clientX - c.getBoundingClientRect().left - PAD.l;
    const pw = width - PAD.l - PAD.r;
    if (x < 0 || x > pw) return null;
    const t = (x / pw) * timeline.total;
    let i = timeline.indexAt(t);
    // snap to the nearest cutting move
    for (let d = 0; d < 400; d++) {
      if (analysis.level[i + d] >= 0) return i + d;
      if (i - d >= 0 && analysis.level[i - d] >= 0) return i - d;
    }
    return i;
  };

  const hv = hover ? analysis.values[metric][hover.i] : NaN;
  return (
    <div className="chart-wrap" ref={wrap}>
      <canvas
        ref={canvas}
        style={{ width: "100%", height: H, display: "block", cursor: "crosshair" }}
        onMouseMove={(e) => {
          const i = pick(e.clientX);
          setHover(i === null ? null : { x: e.nativeEvent.offsetX, i });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onSelect(pick(e.clientX))}
      />
      {hover && (
        <div className="chart-tip" style={{ left: Math.min(hover.x + 12, width - 190) }}>
          <b>Line {timeline.moves[hover.i].line}</b> · {fmtTime(timeline.startOf(hover.i))}
          <br />
          {Number.isFinite(hv) ? `${hv.toFixed(digits)} ${unit}` : "air"} · {LEVELS[Math.max(0, analysis.level[hover.i])].label}
        </div>
      )}
    </div>
  );
}

function MoveDetail({ i, result, analysis, onShow }: { i: number; result: InterpretResponse; analysis: Analysis; onShow: () => void }) {
  const m = result.moves[i];
  const v = analysis.values;
  const lv = analysis.level[i];
  const f = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : "–");
  return (
    <div className="move-detail">
      <div className="md-code mono">
        <span className="muted">Line {m.line}</span> {result.blocks[m.block]?.text}
      </div>
      <div className="md-vals">
        <span style={{ color: LEVELS[Math.max(0, lv)].color }}>● {LEVELS[Math.max(0, lv)].label}</span>
        <span>F {m.feed ?? "–"}</span>
        <span>MRR {f(v.mrr[i], 1)} cm³/min</span>
        <span>ap {f(v.ap[i], 2)} mm</span>
        <span>ae {f(v.ae[i], 0)}%</span>
        <span>angle {f(v.angle[i], 0)}°</span>
        <span>hex {f(v.hex[i], 3)} mm</span>
      </div>
      <button className="btn" onClick={onShow}>
        Show in simulator
      </button>
    </div>
  );
}

function Heaviest({
  result,
  analysis,
  metric,
  selected,
  onSelect,
}: {
  result: InterpretResponse;
  analysis: Analysis;
  metric: Metric;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const rows = useMemo(() => {
    const v = analysis.values[metric];
    const idx: number[] = [];
    const seenLine = new Set<number>();
    const order = Array.from(v.keys())
      .filter((i) => Number.isFinite(v[i]) && v[i] > 0)
      .sort((a, b) => v[b] - v[a]);
    for (const i of order) {
      const line = result.moves[i].line;
      if (seenLine.has(line)) continue;
      seenLine.add(line);
      idx.push(i);
      if (idx.length >= 40) break;
    }
    return idx;
  }, [analysis, metric, result]);
  const v = analysis.values;
  const f = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : "–");
  const def = METRICS.find((m) => m.key === metric)!;
  return (
    <div className="card opt-heavy">
      <h3>
        Highest {def.label.toLowerCase()} <span className="muted">· top {rows.length} lines</span>
      </h3>
      <div className="set-scroll">
        <table className="diag set-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Block</th>
              <th className="rt">F</th>
              <th className="rt">ap mm</th>
              <th className="rt">ae %</th>
              <th className="rt">Angle °</th>
              <th className="rt">MRR cm³/min</th>
              <th className="rt">hex mm</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const m = result.moves[i];
              return (
                <tr key={i} className={i === selected ? "current" : ""} onClick={() => onSelect(i)}>
                  <td className="mono">
                    <i className="lv-dot" style={{ background: LEVELS[Math.max(0, analysis.level[i])].color }} />
                    {m.line}
                  </td>
                  <td className="mono blk">{result.blocks[m.block]?.text}</td>
                  <td className="rt mono">{m.feed ?? "–"}</td>
                  <td className="rt mono">{f(v.ap[i], 2)}</td>
                  <td className="rt mono">{f(v.ae[i], 0)}</td>
                  <td className="rt mono">{f(v.angle[i], 0)}</td>
                  <td className="rt mono">{f(v.mrr[i], 1)}</td>
                  <td className="rt mono">{f(v.hex[i], 3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
