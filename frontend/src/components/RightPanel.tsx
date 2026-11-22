import type { InterpretResponse, InterpreterSetup, ToolInfo, ToolOverride, ToolType } from "../types";
import { toolColor } from "../viewer/StockMesh";
import { NumberField, Row, Section } from "./fields";
import { STATUS_LABEL, fmtDist, fmtTime } from "./format";

interface Props {
  result: InterpretResponse | null;
  setup: InterpreterSetup;
  overrides: Record<string, ToolOverride>;
  onOverride: (key: string, o: ToolOverride | null) => void;
  dirty: boolean;
  canApply: boolean;
  onApply: () => void;
  activeTool: number | null;
}

const TOOL_TYPES: { key: ToolType; label: string }[] = [
  { key: "flat", label: "Flat end mill" },
  { key: "ball", label: "Ball nose" },
  { key: "bull", label: "Bull nose" },
  { key: "face", label: "Face mill" },
  { key: "drill", label: "Drill" },
  { key: "spot", label: "Spot drill" },
  { key: "reamer", label: "Reamer" },
  { key: "tap", label: "Tap" },
  { key: "counterbore", label: "Counterbore" },
];

const SOURCE_LABEL: Record<string, string> = {
  comment: "from program comment",
  user: "set by you",
  default: "assumed, please check",
};

const STOCK_CODES = new Set(["RAPID_IN_STOCK", "SPINDLE_OFF_IN_STOCK", "BELOW_STOCK_BOTTOM", "TOOL_ASSUMED"]);

export function RightPanel({ result, setup, overrides, onOverride, dirty, canApply, onApply, activeTool }: Props) {
  const s = result?.summary;
  const stockDiags = result?.diagnostics.filter((d) => STOCK_CODES.has(d.code)) ?? [];
  const stockState = stockDiags.some((d) => d.severity === "error") ? "fail" : stockDiags.some((d) => d.severity === "warning") ? "warn" : "pass";
  const interpState = !s ? "na" : s.status === "halted" ? "fail" : result!.diagnostics.some((d) => d.severity === "error" && !STOCK_CODES.has(d.code)) ? "fail" : result!.diagnostics.some((d) => d.severity === "warning" && !STOCK_CODES.has(d.code)) ? "warn" : "pass";

  const checks: { label: string; state: string; note: string }[] = [
    { label: "G-code interpretation", state: interpState, note: "" },
    { label: "Material removal", state: s ? stockState : "na", note: s ? "" : "" },
    { label: "Tool & holder geometry", state: "na", note: "Phase 3" },
    { label: "Vice / fixture clearance", state: "na", note: "Phase 3" },
    { label: "Machine travel limits", state: "na", note: "Phase 4" },
    { label: "Collision detection", state: "na", note: "Phase 4" },
  ];
  const stateText = (st: string, note: string) => (st === "pass" ? "Done" : st === "warn" ? "Review" : st === "fail" ? "Failed" : `Not checked · ${note}`);

  const cutStats = new Map((s?.tools ?? []).map((t) => [String(t.tool ?? "none"), t]));
  const tools = (result?.tools ?? []).filter((t) => t.number !== null || (cutStats.get("none")?.cut_length ?? 0) > 0);

  return (
    <aside className="panel right">
      <div className="panel-title">Verification · tools · machine</div>
      <div className="panel-scroll">
        <Section title="Verification status">
          {s ? (
            <>
              <div className={`verdict status-${s.status}`}>
                <div className="verdict-title">{STATUS_LABEL[s.status]}</div>
                <div className="verdict-counts">
                  <span className="c-err">{s.errors} errors</span>
                  <span className="c-warn">{s.warnings} warnings</span>
                  <span className="c-info">{s.infos} notes</span>
                </div>
              </div>
              <ul className="checks">
                {checks.map((c) => (
                  <li key={c.label} className={`check ${c.state}`}>
                    <span className="check-dot" />
                    <span className="check-label">{c.label}</span>
                    <span className="check-state">{stateText(c.state, c.note)}</span>
                  </li>
                ))}
              </ul>
              <p className="note strong">Complete verification is not claimed: tool holders, fixtures, machine limits and collisions are not checked yet.</p>
            </>
          ) : (
            <p className="note">Upload a program to see its status.</p>
          )}
        </Section>

        <Section title="Tools in program" badge={result ? <span className="badge">{tools.length}</span> : undefined}>
          {tools.length > 0 ? (
            <div className="tool-cards">
              {tools.map((t) => (
                <ToolCard
                  key={t.key}
                  tool={t}
                  override={overrides[t.key]}
                  onOverride={(o) => onOverride(t.key, o)}
                  active={t.number === activeTool}
                  cutLength={cutStats.get(t.key)?.cut_length ?? 0}
                  cutTime={cutStats.get(t.key)?.cut_time ?? 0}
                />
              ))}
            </div>
          ) : (
            <p className="note">No tools yet.</p>
          )}
          {dirty && (
            <button className="btn primary block" disabled={!canApply} onClick={onApply}>
              Apply &amp; re-run simulation
            </button>
          )}
          <p className="note">Sizes are read from the CAM comments where possible. Holders, lengths and the saved tool library come in Phase 3.</p>
        </Section>

        <Section title="Machine" defaultOpen={false}>
          <Row label="Machine">
            <span className="value">Generic 3-axis VMC</span>
          </Row>
          <Row label="Controller">
            <span className="value">FANUC</span>
          </Row>
          <Row label="Rapid traverse">
            <span className="value mono">{setup.rapid_rate.toLocaleString()} mm/min</span>
          </Row>
          <Row label="Travel limits">
            <span className="value muted">Not configured</span>
          </Row>
          <Row label="Tool change position">
            <span className="value muted">Not configured</span>
          </Row>
          <p className="note">Machine library, travel limits and kinematics are configured in Phase 4.</p>
        </Section>
      </div>
    </aside>
  );
}

function ToolCard({
  tool,
  override,
  onOverride,
  active,
  cutLength,
  cutTime,
}: {
  tool: ToolInfo;
  override?: ToolOverride;
  onOverride: (o: ToolOverride | null) => void;
  active: boolean;
  cutLength: number;
  cutTime: number;
}) {
  const cur: ToolOverride = override ?? { type: tool.type as ToolType, diameter: tool.diameter, corner_radius: tool.corner_radius };
  const set = (patch: Partial<ToolOverride>) => onOverride({ ...cur, ...patch });
  const source = override ? "user" : tool.source;
  return (
    <div className={`tool-card ${active ? "active" : ""} src-${source}`}>
      <div className="tool-head">
        <span className="swatch" style={{ background: toolColor(tool.number) }} title="Colour of surfaces cut by this tool" />
        <span className="tool-no mono">{tool.number === null ? "T?" : `T${tool.number}`}</span>
        <span className={`tool-src ${source}`}>{SOURCE_LABEL[source] ?? source}</span>
        {override && (
          <button className="link" onClick={() => onOverride(null)} title="Use the size from the program">
            reset
          </button>
        )}
      </div>
      <div className="tool-fields">
        <select className="select" value={cur.type} onChange={(e) => set({ type: e.target.value as ToolType })}>
          {TOOL_TYPES.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <NumberField label="Ø" value={cur.diameter} min={0.1} step={0.5} onChange={(v) => set({ diameter: v })} />
        {cur.type === "bull" && <NumberField label="R" value={cur.corner_radius} min={0} step={0.1} onChange={(v) => set({ corner_radius: v })} />}
      </div>
      <div className="tool-stats mono">
        <span>{fmtDist(cutLength)} cut</span>
        <span>{fmtTime(cutTime)}</span>
      </div>
      {tool.description && !override && <div className="tool-desc">{tool.description}</div>}
    </div>
  );
}
