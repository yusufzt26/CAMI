import { fmtTime } from "./format";

const SPEEDS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500];

interface Props {
  disabled: boolean;
  playing: boolean;
  time: number;
  total: number;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onReset: () => void;
  onStep: (dir: 1 | -1) => void;
  onSpeed: (s: number) => void;
  onSeek: (t: number) => void;
}

export function PlaybackBar(p: Props) {
  const pct = p.total > 0 ? (p.time / p.total) * 100 : 0;
  return (
    <div className="playback">
      <div className="pb-buttons">
        <button className="pbtn" title="Reset (start + default view)" disabled={p.disabled} onClick={p.onReset}>
          ⟲
        </button>
        <button className="pbtn" title="Step back one move" disabled={p.disabled} onClick={() => p.onStep(-1)}>
          ⏮
        </button>
        {p.playing ? (
          <button className="pbtn main" title="Pause" disabled={p.disabled} onClick={p.onPause}>
            ⏸
          </button>
        ) : (
          <button className="pbtn main" title="Play" disabled={p.disabled} onClick={p.onPlay}>
            ▶
          </button>
        )}
        <button className="pbtn" title="Stop (return to start)" disabled={p.disabled} onClick={p.onStop}>
          ⏹
        </button>
        <button className="pbtn" title="Step forward one move" disabled={p.disabled} onClick={() => p.onStep(1)}>
          ⏭
        </button>
      </div>
      <div className="pb-time mono">{fmtTime(p.time)}</div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={p.total || 1}
        step={p.total / 2000 || 0.001}
        value={p.time}
        disabled={p.disabled}
        style={{ ["--pct" as string]: `${pct}%` }}
        onChange={(e) => p.onSeek(Number(e.target.value))}
        aria-label="Simulation timeline"
      />
      <div className="pb-time mono">{fmtTime(p.total)}</div>
      <label className="pb-speed" title="Simulation speed (1x = estimated machine time)">
        Speed
        <select className="select" value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
