import { WCS, type InterpreterSetup, type StockOrigin, type StockSetup, type Vec3 } from "../types";
import { NumberField, Row, Section } from "./fields";

const MATERIALS = [
  "P20 mould steel",
  "1.2311",
  "1.2738",
  "1.2343 / H13",
  "C45 / EN8",
  "Mild steel",
  "Aluminium 6061",
  "Aluminium 7075",
  "Cast iron",
];

const ORIGINS: { key: StockOrigin; label: string }[] = [
  { key: "top-center", label: "Top · centre" },
  { key: "top-front-left", label: "Top · front-left corner" },
  { key: "top-front-right", label: "Top · front-right corner" },
  { key: "top-back-left", label: "Top · back-left corner" },
  { key: "top-back-right", label: "Top · back-right corner" },
];

interface Props {
  stock: StockSetup;
  onStock: (s: StockSetup) => void;
  setup: InterpreterSetup;
  onSetup: (s: InterpreterSetup) => void;
  dirty: boolean;
  canApply: boolean;
  onApply: () => void;
}

const setVec = (v: Vec3, i: number, x: number): Vec3 => v.map((c, k) => (k === i ? x : c)) as Vec3;

export function JobSetupPanel({ stock, onStock, setup, onSetup, dirty, canApply, onApply }: Props) {
  const upd = (patch: Partial<InterpreterSetup>) => onSetup({ ...setup, ...patch });
  return (
    <aside className="panel left">
      <div className="panel-title">Job &amp; stock setup</div>
      <div className="panel-scroll">
        <Section title="Raw material">
          <div className="xyz">
            {(["X", "Y", "Z"] as const).map((a, i) => (
              <NumberField key={a} label={a} value={stock.size[i]} min={0.1} suffix="mm" onChange={(v) => onStock({ ...stock, size: setVec(stock.size, i, v) })} />
            ))}
          </div>
          <Row label="Material">
            <select className="select" value={stock.material} onChange={(e) => onStock({ ...stock, material: e.target.value })}>
              {MATERIALS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Row>
          <Row label="Part zero on stock" hint="Where the program zero (G54) sits on the raw block">
            <select className="select" value={stock.origin} onChange={(e) => onStock({ ...stock, origin: e.target.value as StockOrigin })}>
              {ORIGINS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Stock top at Z" hint="Z of the stock top face in program coordinates">
            <NumberField value={stock.topZ} step={0.1} suffix="mm" onChange={(v) => onStock({ ...stock, topZ: v })} />
          </Row>
          <Row label="Stock allowance" hint="Extra material on sides and top">
            <NumberField value={stock.allowance} min={0} step={0.1} suffix="mm" onChange={(v) => onStock({ ...stock, allowance: v })} />
          </Row>
          <p className="note">STEP/STL workpiece import and real material removal come in Phase 2–3. The stock is shown as an envelope for now.</p>
        </Section>

        <Section title="Work offsets" defaultOpen={false}>
          <p className="note">Machine coordinates of each work zero. Leave at 0 when only G54 is used.</p>
          <table className="offsets">
            <thead>
              <tr>
                <th />
                <th>X</th>
                <th>Y</th>
                <th>Z</th>
              </tr>
            </thead>
            <tbody>
              {WCS.map((c) => (
                <tr key={c}>
                  <td className="mono">{c}</td>
                  {[0, 1, 2].map((i) => (
                    <td key={i}>
                      <NumberField
                        value={setup.work_offsets[c][i]}
                        step={0.001}
                        onChange={(v) => upd({ work_offsets: { ...setup.work_offsets, [c]: setVec(setup.work_offsets[c], i, v) } })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Row label="G28 reference (machine)">
            <div className="xyz compact">
              {[0, 1, 2].map((i) => (
                <NumberField key={i} value={setup.reference_position[i]} step={1} onChange={(v) => upd({ reference_position: setVec(setup.reference_position, i, v) })} />
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Controller & interpretation">
          <Row label="Controller">
            <select className="select" value={setup.controller} onChange={(e) => upd({ controller: e.target.value })}>
              <option value="fanuc">FANUC (0i / 30i milling)</option>
              <option value="siemens" disabled>
                Siemens 828D / 840D (planned)
              </option>
              <option value="mitsubishi" disabled>
                Mitsubishi M8 (planned)
              </option>
            </select>
          </Row>
          <Row label="Power-on units">
            <select className="select" value={setup.initial_units} onChange={(e) => upd({ initial_units: e.target.value as "mm" | "inch" })}>
              <option value="mm">Metric (G21)</option>
              <option value="inch">Inch (G20)</option>
            </select>
          </Row>
          <Row label="Coordinates without decimal" hint="FANUC parameter 3401#0 (DPI)">
            <select className="select" value={setup.decimal_mode} onChange={(e) => upd({ decimal_mode: e.target.value as InterpreterSetup["decimal_mode"] })}>
              <option value="calculator">X10 = 10 mm (calculator)</option>
              <option value="least_increment">X10 = 0.010 mm (DPI = 0)</option>
            </select>
          </Row>
          <Row label="Rapid path" hint="FANUC parameter 1401#1 (LRP)">
            <select className="select" value={setup.rapid_mode} onChange={(e) => upd({ rapid_mode: e.target.value as InterpreterSetup["rapid_mode"] })}>
              <option value="linear">Straight line (interpolated)</option>
              <option value="dogleg">Dog-leg (axes independent)</option>
            </select>
          </Row>
          <Row label="Block delete switch">
            <select className="select" value={setup.block_delete_switch ? "on" : "off"} onChange={(e) => upd({ block_delete_switch: e.target.value === "on" })}>
              <option value="off">OFF (run '/' blocks)</option>
              <option value="on">ON (skip '/' blocks)</option>
            </select>
          </Row>
          <Row label="Rapid traverse">
            <NumberField value={setup.rapid_rate} min={1} step={500} suffix="mm/min" onChange={(v) => upd({ rapid_rate: v })} />
          </Row>
          <Row label="Max cutting feed">
            <NumberField value={setup.max_feed} min={1} step={500} suffix="mm/min" onChange={(v) => upd({ max_feed: v })} />
          </Row>
          <Row label="Tool change time">
            <NumberField value={setup.tool_change_time} min={0} step={0.5} suffix="s" onChange={(v) => upd({ tool_change_time: v })} />
          </Row>
        </Section>
      </div>
      <div className="panel-foot">
        <button className="btn primary block" disabled={!canApply || !dirty} onClick={onApply}>
          {dirty ? "Apply & re-run interpretation" : "Settings applied"}
        </button>
      </div>
    </aside>
  );
}
