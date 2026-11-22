import { useEffect, useMemo, useRef, useState } from "react";
import { zipSync, strToU8 } from "fflate";
import type { Timeline } from "../sim/timeline";
import type { InterpretResponse } from "../types";
import type { InterpreterSettings } from "../engine/interpreter";
import { fmtTime } from "../components/format";
import type { Analysis } from "./analysis";
import { DEFAULT_FEED_SETTINGS, type FeedPlan, type FeedSettings, REASONS, type Reason, planFeeds } from "./feed";

interface Props {
  result: InterpretResponse;
  analysis: Analysis;
  timeline: Timeline;
  getText: () => Promise<string>;
  settings: () => InterpreterSettings;
  onSelect: (moveIndex: number) => void;
  onPlan?: (plan: FeedPlan | null) => void;
}

type Busy = null | "plan" | "save";

const loadSettings = (): FeedSettings => {
  try {
    const s = localStorage.getItem("cami.feedSettings");
    if (s) return { ...DEFAULT_FEED_SETTINGS, ...JSON.parse(s) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_FEED_SETTINGS;
};

export function FeedPanel({ result, analysis, timeline, getText, settings, onSelect, onPlan }: Props) {
  const [s, setS] = useState<FeedSettings>(loadSettings);
  const [plan, setPlan] = useState<FeedPlan | null>(null);
  const [planFor, setPlanFor] = useState<string>("");
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const key = JSON.stringify(s);
  const stale = plan !== null && planFor !== key;
  useEffect(() => {
    try {
      localStorage.setItem("cami.feedSettings", key);
    } catch {
      /* storage unavailable */
    }
  }, [key]);
  useEffect(() => {
    setPlan(null);
    setMsg(null);
    onPlan?.(null);
  }, [result, analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FeedSettings>(k: K, v: FeedSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const num = (k: keyof FeedSettings, min: number, max: number) => ({
    type: "number",
    min,
    max,
    value: s[k] as number,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v)) set(k, Math.max(min, Math.min(max, v)) as never);
    },
  });

  const run = async () => {
    setBusy("plan");
    setMsg(null);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const text = await getText();
      const p = planFeeds(result, analysis, text, settings(), s);
      setPlan(p);
      setPlanFor(key);
      onPlan?.(p);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!plan || !plan.check?.ok) return;
    setBusy("save");
    setMsg(null);
    try {
      const dl = await getDownloads();
      if (dl) {
        // The viewer only accepts some file types, so the .nc goes inside a .zip.
        const zip = zipSync({ [plan.filename]: strToU8(plan.text) });
        await dl.save({ filename: plan.filename.replace(/\.[^.]*$/, "") + ".zip", data: zip });
        setMsg(`Saved ${plan.filename} (inside a .zip).`);
      } else {
        const url = URL.createObjectURL(new Blob([plan.text], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = plan.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (e) {
      const code = (e as { code?: string })?.code;
      setMsg(code === "declined" ? "Download cancelled." : `Download failed${code ? ` (${code})` : ""}. Use Copy NC instead.`);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.text);
      setMsg("Optimised NC copied to the clipboard.");
    } catch {
      setMsg("The clipboard is not available here. Use Download.");
    }
  };

  const c = plan?.check;
  const saved = c ? c.oldTime - c.newTime : 0;

  return (
    <section className="card feed">
      <div className="feed-head">
        <div>
          <div className="opt-kicker">Feed optimisation · phase 2</div>
          <h3>Adjust F values from the cutting load</h3>
          <p className="muted">Only F words change. The optimised program is interpreted again and every position, arc, tool and spindle value must match the original before it can be saved.</p>
        </div>
        <div className="feed-actions">
          <label className="feed-ctrl">
            Output for
            <select className="select" value={s.controller} onChange={(e) => set("controller", e.target.value as FeedSettings["controller"])}>
              <option value="fanuc">FANUC 0i / 30i</option>
              <option value="m80">Mitsubishi M80</option>
            </select>
          </label>
          <button className="btn primary" onClick={run} disabled={busy !== null}>
            {busy === "plan" ? "Optimising…" : plan ? "Optimise again" : "Optimise feeds"}
          </button>
        </div>
      </div>

      <div className="feed-rules">
        <fieldset className={s.chipThinning ? "" : "off"}>
          <legend>
            <label>
              <input type="checkbox" checked={s.chipThinning} onChange={(e) => set("chipThinning", e.target.checked)} /> Chip thinning
            </label>
          </legend>
          <p>Light cuts (engagement under 90°) make thin chips. Raise F towards the programmed chip load.</p>
          <label>
            Max increase <input {...num("maxIncrease", 0, 200)} /> %
          </label>
        </fieldset>
        <fieldset className={s.heavy ? "" : "off"}>
          <legend>
            <label>
              <input type="checkbox" checked={s.heavy} onChange={(e) => set("heavy", e.target.checked)} /> Heavy load
            </label>
          </legend>
          <p>Slow down deep, wide cuts. Straight Z plunges keep the CAM plunge feed.</p>
          <label>
            Heavy 120–170° <input {...num("heavyPct", 10, 100)} /> % of F
          </label>
          <label>
            Full width <input {...num("fullPct", 10, 100)} /> % of F
          </label>
          <label>
            Only when ap ≥ <input {...num("heavyApPct", 0, 200)} /> % of Ø
          </label>
        </fieldset>
        <fieldset className={s.air ? "" : "off"}>
          <legend>
            <label>
              <input type="checkbox" checked={s.air} onChange={(e) => set("air", e.target.checked)} /> Air moves
            </label>
          </legend>
          <p>Speed up feed moves that stay clear of the stock.</p>
          <label>
            Air feed <input {...num("airPct", 100, 500)} /> % of F
          </label>
          <label>
            Min. clearance <input {...num("airGap", 0.5, 50)} /> mm
          </label>
        </fieldset>
        <fieldset>
          <legend>Limits</legend>
          <label>
            Min feed <input {...num("minFeed", 1, 100000)} /> mm/min
          </label>
          <label>
            Max feed <input {...num("maxFeed", 10, 100000)} /> mm/min
          </label>
          <label>
            Round to <input {...num("step", 1, 1000)} /> mm/min
          </label>
          <label>
            Skip changes under <input {...num("minChange", 0, 50)} /> %
          </label>
        </fieldset>
      </div>

      {msg && <div className="notice-inline">{msg}</div>}

      {plan && !plan.ok && <div className="opt-warn">{plan.blocked}</div>}
      {plan && plan.ok && !plan.changes.length && <div className="notice-inline">No feed changes with these rules. The program is already within the limits.</div>}

      {plan && plan.ok && c && (
        <>
          {stale && <div className="notice-inline">The rules changed. Press "Optimise again" to update the result.</div>}
          <div className="kpis feed-kpis">
            <div className="kpi">
              <div className="kpi-label">Cycle time</div>
              <div className="kpi-value mono">
                {fmtTime(c.oldTime)} → {fmtTime(c.newTime)}
              </div>
              <div className="kpi-sub">
                {saved >= 0 ? "saves" : "adds"} {fmtTime(Math.abs(saved))} · {c.oldTime > 0 ? ((100 * Math.abs(saved)) / c.oldTime).toFixed(1) : "0"}%
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Cutting time</div>
              <div className="kpi-value mono">
                {fmtTime(c.cutOld)} → {fmtTime(c.cutNew)}
              </div>
              <div className="kpi-sub">G01 / G02 / G03 only</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Lines with a new feed</div>
              <div className="kpi-value mono">{plan.changes.length.toLocaleString()}</div>
              <div className="kpi-sub">
                {plan.stats.raised.toLocaleString()} raised · {plan.stats.reduced.toLocaleString()} reduced
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">F words written</div>
              <div className="kpi-value mono">{plan.stats.written.toLocaleString()}</div>
              <div className="kpi-sub">modal F is reused where possible</div>
            </div>
            <div className={`kpi ${c.ok ? "good" : "hot"}`}>
              <div className="kpi-label">Geometry check</div>
              <div className="kpi-value">{c.ok ? "Identical" : "Failed"}</div>
              <div className="kpi-sub">{c.moves.toLocaleString()} moves compared</div>
            </div>
          </div>
          <div className={c.ok ? "check-ok" : "opt-warn"}>{c.message}</div>

          <div className="feed-reasons">
            {(Object.keys(REASONS) as Reason[]).map((r) => {
              const b = plan.stats.byReason[r];
              return (
                <span key={r}>
                  <i style={{ background: REASONS[r].color }} />
                  {REASONS[r].label}
                  <b className="mono">{b.lines.toLocaleString()} lines</b>
                  <em className="mono">
                    {b.saved >= 0 ? "−" : "+"}
                    {fmtTime(Math.abs(b.saved))}
                  </em>
                </span>
              );
            })}
          </div>

          <FeedChart result={result} timeline={timeline} plan={plan} onSelect={onSelect} />

          <div className="feed-out">
            <div>
              <b className="mono">{plan.filename}</b>
              <span className="muted">
                {" "}
                · {s.controller === "m80" ? "Mitsubishi M80" : "FANUC"} · F words in the program's own format. A comment line at the top marks the file as optimised.
              </span>
            </div>
            <div className="feed-out-btns">
              <button className="btn" onClick={copy} disabled={!c.ok}>
                Copy NC
              </button>
              <button className="btn primary" onClick={save} disabled={!c.ok || busy !== null}>
                {busy === "save" ? "Saving…" : "Download optimised NC"}
              </button>
            </div>
          </div>

          <ChangesTable result={result} plan={plan} onSelect={onSelect} />
        </>
      )}
    </section>
  );
}

interface DownloadsNs {
  save(r: { filename: string; data: string | Uint8Array }): Promise<unknown>;
}
async function getDownloads(): Promise<DownloadsNs | null> {
  const c = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (!c?.use) return null;
  try {
    return (await c.use("downloads")) as DownloadsNs | null;
  } catch {
    return null;
  }
}

function FeedChart({ result, timeline, plan, onSelect }: { result: InterpretResponse; timeline: Timeline; plan: FeedPlan; onSelect: (i: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const H = 180;
  const PAD = { l: 52, r: 12, t: 10, b: 24 };
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const reasonOf = useMemo(() => new Map(plan.changes.map((c) => [c.line, c.reason])), [plan]);
  const max = useMemo(() => {
    let m = 0;
    result.moves.forEach((mv, i) => {
      if (mv.kind !== "feed" && mv.kind !== "arc") return;
      m = Math.max(m, mv.feed ?? 0, Number.isFinite(plan.moveFeed[i]) ? plan.moveFeed[i] : 0);
    });
    return m > 0 ? m * 1.08 : 1;
  }, [result, plan]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);
    const pw = width - PAD.l - PAD.r;
    const ph = H - PAD.t - PAD.b;
    const total = timeline.total || 1;
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#7a8594";
    ctx.strokeStyle = "#e3e8ee";
    for (let g = 0; g <= 4; g++) {
      const y = PAD.t + ph - (g / 4) * ph;
      ctx.beginPath();
      ctx.moveTo(PAD.l, Math.round(y) + 0.5);
      ctx.lineTo(PAD.l + pw, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(((max * g) / 4).toFixed(0), PAD.l - 6, y + 4);
    }
    ctx.textAlign = "center";
    for (let g = 0; g <= 6; g++) ctx.fillText(fmtTime((total * g) / 6), PAD.l + (pw * g) / 6, H - 6);
    const cols = Math.ceil(pw);
    const orig = new Float32Array(cols).fill(-1);
    const neu = new Float32Array(cols).fill(-1);
    const rsn: (Reason | null)[] = new Array(cols).fill(null);
    result.moves.forEach((m, i) => {
      if (m.kind !== "feed" && m.kind !== "arc") return;
      const x0 = Math.floor((timeline.startOf(i) / total) * pw);
      const x1 = Math.max(x0, Math.min(cols - 1, Math.floor((timeline.endOf(i) / total) * pw)));
      const f0 = m.feed ?? 0;
      const f1 = Number.isFinite(plan.moveFeed[i]) ? plan.moveFeed[i] : f0;
      for (let x = x0; x <= x1; x++) {
        if (f0 > orig[x]) orig[x] = f0;
        if (Math.abs(f1 - f0) > Math.abs(neu[x] - orig[x]) || neu[x] < 0) {
          neu[x] = f1;
          rsn[x] = f1 !== f0 ? (reasonOf.get(m.line) ?? null) : null;
        }
      }
    });
    for (let x = 0; x < cols; x++) {
      if (orig[x] < 0) continue;
      const y0 = PAD.t + ph - (orig[x] / max) * ph;
      ctx.fillStyle = "#cbd5e1";
      ctx.fillRect(PAD.l + x, y0, 1, PAD.t + ph - y0);
      const r = rsn[x];
      if (r) {
        const y1 = PAD.t + ph - (neu[x] / max) * ph;
        ctx.fillStyle = REASONS[r].color;
        ctx.fillRect(PAD.l + x, Math.min(y0, y1), 1, Math.max(1.5, Math.abs(y1 - y0)));
      }
    }
  }, [width, plan, result, timeline, max, reasonOf]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="chart-wrap" ref={wrap}>
      <div className="feed-chart-cap muted">Programmed feed (grey) and the change at each point (coloured by rule), mm/min over machining time</div>
      <canvas
        ref={canvas}
        style={{ width: "100%", height: H, display: "block", cursor: "crosshair" }}
        onClick={(e) => {
          const c = canvas.current;
          if (!c) return;
          const pw = width - PAD.l - PAD.r;
          const x = e.clientX - c.getBoundingClientRect().left - PAD.l;
          if (x < 0 || x > pw) return;
          onSelect(timeline.indexAt((x / pw) * timeline.total));
        }}
      />
    </div>
  );
}

function ChangesTable({ result, plan, onSelect }: { result: InterpretResponse; plan: FeedPlan; onSelect: (i: number) => void }) {
  const [filter, setFilter] = useState<Reason | "all">("all");
  const firstMove = useMemo(() => {
    const m = new Map<number, number>();
    result.moves.forEach((mv, i) => {
      if (!m.has(mv.line)) m.set(mv.line, i);
    });
    return m;
  }, [result]);
  const textOf = useMemo(() => new Map(result.blocks.map((b) => [b.line, b.text])), [result]);
  const rows = plan.changes.filter((c) => filter === "all" || c.reason === filter).slice(0, 300);
  const count = filter === "all" ? plan.changes.length : plan.stats.byReason[filter].lines;
  return (
    <div className="feed-changes">
      <div className="feed-changes-head">
        <h3>
          Changed lines <span className="muted">· showing {rows.length.toLocaleString()} of {count.toLocaleString()}</span>
        </h3>
        <select className="select" value={filter} onChange={(e) => setFilter(e.target.value as Reason | "all")}>
          <option value="all">All rules</option>
          {(Object.keys(REASONS) as Reason[]).map((r) => (
            <option key={r} value={r}>
              {REASONS[r].label}
            </option>
          ))}
        </select>
      </div>
      <div className="set-scroll">
        <table className="diag set-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Original block</th>
              <th className="rt">Old F</th>
              <th className="rt">New F</th>
              <th className="rt">Change</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.line} onClick={() => onSelect(firstMove.get(c.line) ?? 0)}>
                <td className="mono">{c.line}</td>
                <td className="mono blk">{textOf.get(c.line)}</td>
                <td className="rt mono">{c.oldF}</td>
                <td className="rt mono">{c.newF}</td>
                <td className={`rt mono ${c.newF > c.oldF ? "up" : "down"}`}>
                  {c.newF > c.oldF ? "+" : ""}
                  {(((c.newF - c.oldF) / c.oldF) * 100).toFixed(0)}%
                </td>
                <td>
                  <i className="lv-dot" style={{ background: REASONS[c.reason].color }} />
                  {REASONS[c.reason].label}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
