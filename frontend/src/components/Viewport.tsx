import { useEffect, useRef, useState } from "react";
import type { Timeline } from "../sim/timeline";
import type { InterpretResponse } from "../types";
import { PATH_COLORS, SceneView, type Layer, type ViewName } from "../viewer/SceneView";
import { fmtNum } from "./format";

type State = ReturnType<Timeline["stateAt"]>;

interface Props {
  onReady: (s: SceneView | null) => void;
  onUpload: (f: File) => void;
  hasProgram: boolean;
  busy: string | null;
  error: string | null;
  onDismissError: () => void;
  result: InterpretResponse | null;
  state: State;
  onView: (v: ViewName) => void;
  onZoom: (factor: number) => void;
  onLayer: (layer: Layer, visible: boolean) => void;
}

const LAYERS: { key: Layer; label: string }[] = [
  { key: "stock", label: "Stock" },
  { key: "path", label: "Toolpath" },
  { key: "tool", label: "Tool" },
];

const VIEWS: { key: ViewName; label: string; title: string }[] = [
  { key: "iso", label: "ISO", title: "Isometric view" },
  { key: "top", label: "TOP", title: "Top view (looking down Z)" },
  { key: "front", label: "FRONT", title: "Front view (looking along +Y)" },
  { key: "side", label: "SIDE", title: "Right side view (looking along -X)" },
];

const KIND_LABEL: Record<string, string> = {
  rapid: "RAPID G00",
  feed: "FEED G01",
  arc: "ARC",
  dwell: "DWELL",
  toolchange: "TOOL CHANGE",
  stop: "STOP",
};

export function Viewport({ onReady, onUpload, hasProgram, busy, error, onDismissError, result, state, onView, onZoom, onLayer }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ stock: true, path: true, tool: true });

  useEffect(() => {
    if (!host.current) return;
    const scene = new SceneView(host.current);
    onReady(scene);
    return () => {
      onReady(null);
      scene.dispose();
    };
  }, [onReady]);

  const summary = result?.summary;
  const haltDiag = result?.diagnostics.find((d) => d.halt);
  const m = state?.move;
  const op = m?.op && m.op !== "none" && m.op !== "position" ? m.op.toUpperCase() : null;

  return (
    <div
      className={`viewport ${drag ? "drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onUpload(f);
      }}
    >
      <div className="viewport-canvas" ref={host} />

      <div className="view-tools">
        {VIEWS.map((v) => (
          <button key={v.key} className="vbtn" title={v.title} onClick={() => onView(v.key)}>
            {v.label}
          </button>
        ))}
        <span className="vsep" />
        <button className="vbtn" title="Zoom in" onClick={() => onZoom(0.8)}>
          +
        </button>
        <button className="vbtn" title="Zoom out" onClick={() => onZoom(1.25)}>
          −
        </button>
        <button className="vbtn" title="Fit all" onClick={() => onView("iso")}>
          FIT
        </button>
      </div>

      {state && (
        <div className="dro">
          <div className="dro-axes">
            {(["X", "Y", "Z"] as const).map((a, i) => (
              <div key={a} className="dro-axis">
                <span className="dro-letter">{a}</span>
                <span className="dro-value">{fmtNum(state.pos[i])}</span>
              </div>
            ))}
          </div>
          <div className="dro-meta">
            <span>
              <b>T</b>
              {m?.tool ?? "–"}
            </span>
            <span>
              <b>S</b>
              {m ? Math.abs(m.spindle).toFixed(0) : 0}
              {m && m.spindle > 0 ? " CW" : m && m.spindle < 0 ? " CCW" : ""}
            </span>
            <span>
              <b>F</b>
              {m?.kind === "rapid" ? "RAPID" : m?.feed ? m.feed.toFixed(0) : "–"}
            </span>
            <span className={m?.coolant ? "on" : ""}>
              <b>COOL</b>
              {m?.coolant ? "ON" : "OFF"}
            </span>
          </div>
          <div className="dro-mode">
            <span className="mode-chip">{m ? KIND_LABEL[m.kind] : ""}</span>
            {op && <span className="mode-chip op">{op}</span>}
            <span className="dro-line">N-line {m?.line}</span>
          </div>
        </div>
      )}

      {hasProgram && (
        <div className="layers">
          {LAYERS.map((l) => (
            <label key={l.key} className={layers[l.key] ? "on" : ""}>
              <input
                type="checkbox"
                checked={layers[l.key]}
                onChange={(e) => {
                  setLayers((v) => ({ ...v, [l.key]: e.target.checked }));
                  onLayer(l.key, e.target.checked);
                }}
              />
              {l.label}
            </label>
          ))}
        </div>
      )}

      {hasProgram && (
        <div className="legend">
          <span>
            <i style={{ background: PATH_COLORS.rapid }} />
            Rapid
          </span>
          <span>
            <i style={{ background: PATH_COLORS.mill }} />
            Cutting
          </span>
          <span>
            <i style={{ background: PATH_COLORS.hole }} />
            Drill / tap / bore
          </span>
          <span>
            <i style={{ background: PATH_COLORS.reference }} />
            Reference return
          </span>
        </div>
      )}

      {summary?.status === "halted" && haltDiag && (
        <div className="halt-banner" role="alert">
          <b>Verification stopped at line {haltDiag.line}.</b> {haltDiag.message}
          <div className="halt-sub">The toolpath after this block was not simulated. Fix the program or extend the controller support before running it on the machine.</div>
        </div>
      )}

      {!hasProgram && !busy && (
        <div className="empty">
          <div className="empty-icon" aria-hidden>
            ⤒
          </div>
          <h2>Drop a G-code program or .zip here</h2>
          <p>or use Upload G-code above. Accepted: .NC · .TXT · .GCODE · .TAP, or a .ZIP of them</p>
          <p className="muted">FANUC milling dialect. Unknown or unsafe codes stop verification instead of being skipped.</p>
        </div>
      )}

      {busy && (
        <div className="busy">
          <div className="spinner" />
          {busy}
        </div>
      )}

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button onClick={onDismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {drag && <div className="drop-overlay">Release to upload</div>}
    </div>
  );
}
