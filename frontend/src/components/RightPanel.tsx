import type { InterpretResponse, InterpreterSetup } from "../types";
import { NumberField, Row, Section } from "./fields";
import { STATUS_LABEL, fmtDist, fmtTime } from "./format";

interface Props {
  result: InterpretResponse | null;
  setup: InterpreterSetup;
  toolDiameters: Record<string, number>;
  onToolDiameter: (tool: string, d: number) => void;
  activeTool: number | null;
}

const CHECKS: { label: string; phase: string }[] = [
  { label: "G-code interpretation", phase: "1" },
  { label: "Material removal", phase: "2" },
  { label: "Tool & holder geometry", phase: "3" },
  { label: "Vice / fixture clearance", phase: "3" },
  { label: "Machine travel limits", phase: "4" },
  { label: "Collision detection", phase: "4" },
];

export function RightPanel({ result, setup, toolDiameters, onToolDiameter, activeTool }: Props) {
  const s = result?.summary;
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
                {CHECKS.map((c) => {
                  const done = c.phase === "1";
                  const state = done ? (s.status === "halted" ? "fail" : s.status === "errors" ? "fail" : s.status === "warnings" ? "warn" : "pass") : "na";
                  return (
                    <li key={c.label} className={`check ${state}`}>
                      <span className="check-dot" />
                      <span className="check-label">{c.label}</span>
                      <span className="check-state">{done ? (state === "pass" ? "Done" : state === "warn" ? "Review" : "Failed") : `Not checked · Phase ${c.phase}`}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="note strong">Complete verification is not claimed: only the toolpath has been interpreted.</p>
            </>
          ) : (
            <p className="note">Upload a program to see its status.</p>
          )}
        </Section>

        <Section title="Tools in program" badge={s ? <span className="badge">{s.tools.filter((t) => t.tool !== null).length}</span> : undefined}>
          {s && s.tools.length > 0 ? (
            <table className="tools">
              <thead>
                <tr>
                  <th>T</th>
                  <th>Ø view</th>
                  <th>Cut</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {s.tools.map((t) => {
                  const key = String(t.tool ?? "none");
                  return (
                    <tr key={key} className={t.tool === activeTool ? "active" : ""} title={`${t.operations.join(", ") || "positioning only"} · first used on line ${t.first_line}`}>
                      <td className="mono">{t.tool === null ? "?" : `T${t.tool}`}</td>
                      <td>
                        <NumberField value={toolDiameters[key] ?? 10} min={0.1} step={0.5} width={64} onChange={(v) => onToolDiameter(key, v)} />
                      </td>
                      <td className="mono">{fmtDist(t.cut_length)}</td>
                      <td className="mono">{fmtTime(t.cut_time)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="note">No tools yet.</p>
          )}
          <p className="note">Diameter is for display only. The full tool library (end mills, drills, taps, holders) arrives in Phase 3.</p>
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
