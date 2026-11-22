import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { interpretProgram, listPrograms, uploadProgram, type JobSetup } from "./api";
import { BottomPanel } from "./components/BottomPanel";
import { JobSetupPanel } from "./components/JobSetupPanel";
import { PlaybackBar } from "./components/PlaybackBar";
import { RightPanel } from "./components/RightPanel";
import { TopBar } from "./components/TopBar";
import { Viewport } from "./components/Viewport";
import { Timeline } from "./sim/timeline";
import type { SceneView } from "./viewer/SceneView";
import {
  defaultInterpreterSetup,
  defaultStock,
  type InterpretResponse,
  type InterpreterSetup,
  type ProgramMeta,
  type StockSetup,
  type ToolOverride,
} from "./types";

const UI_REFRESH_MS = 80;

export default function App() {
  const [programs, setPrograms] = useState<ProgramMeta[]>([]);
  const [current, setCurrent] = useState<ProgramMeta | null>(null);
  const [result, setResult] = useState<InterpretResponse | null>(null);
  const [setup, setSetup] = useState<InterpreterSetup>(defaultInterpreterSetup);
  const [stock, setStock] = useState<StockSetup>(defaultStock);
  const [toolOverrides, setToolOverrides] = useState<Record<string, ToolOverride>>({});
  const job: JobSetup = useMemo(() => ({ interpreter: setup, stock, tools: toolOverrides }), [setup, stock, toolOverrides]);
  const [appliedJob, setAppliedJob] = useState<JobSetup>(job);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [uiTime, setUiTime] = useState(0);
  const timeRef = useRef(0);
  const sceneRef = useRef<SceneView | null>(null);

  const timeline = useMemo(() => (result ? new Timeline(result.moves) : null), [result]);

  useEffect(() => {
    listPrograms().then(setPrograms).catch(() => setPrograms([]));
  }, []);

  const seek = useCallback(
    (t: number) => {
      const total = timeline?.total ?? 0;
      const clamped = Math.max(0, Math.min(t, total));
      timeRef.current = clamped;
      sceneRef.current?.setTime(clamped);
      setUiTime(clamped);
    },
    [timeline],
  );

  // Playback loop
  useEffect(() => {
    if (!playing || !timeline) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let t = timeRef.current + dt * speed;
      if (t >= timeline.total) {
        t = timeline.total;
        setPlaying(false);
      }
      timeRef.current = t;
      sceneRef.current?.setTime(t);
      if (now - lastUi > UI_REFRESH_MS || t >= timeline.total) {
        lastUi = now;
        setUiTime(t);
      }
      if (t < timeline.total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, timeline]);

  const runInterpretation = useCallback(async (prog: ProgramMeta, j: JobSetup) => {
    setBusy("Interpreting program and simulating stock…");
    setError(null);
    setPlaying(false);
    try {
      const res = await interpretProgram(prog.id, j);
      setResult(res);
      setAppliedJob(j);
      setPrograms(await listPrograms());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  // When a new result arrives: reset playback to the start and frame the view.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setProgram(timeline, result ? { grid: result.stock.grid, tools: result.tools } : undefined);
    const halted = result?.summary.halted_at_block != null && timeline && !timeline.empty;
    scene.setHaltMarker(halted ? timeline!.moves[timeline!.moves.length - 1].end : null);
    timeRef.current = 0;
    scene.setTime(0);
    setUiTime(0);
    scene.setView("iso");
  }, [timeline, result]);

  useEffect(() => {
    sceneRef.current?.setStock(stock);
  }, [stock]);

  const onUpload = useCallback(
    async (file: File) => {
      setBusy(`Uploading ${file.name}…`);
      setError(null);
      try {
        const meta = await uploadProgram(file);
        setCurrent(meta);
        await runInterpretation(meta, job);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      }
    },
    [runInterpretation, job],
  );

  const onOpenProgram = useCallback(
    (id: number) => {
      const meta = programs.find((p) => p.id === id);
      if (!meta) return;
      setCurrent(meta);
      runInterpretation(meta, job);
    },
    [programs, runInterpretation, job],
  );

  const onSceneReady = useCallback(
    (scene: SceneView | null) => {
      sceneRef.current = scene;
      if (scene) {
        scene.setStock(stock);
        scene.setProgram(timeline, result ? { grid: result.stock.grid, tools: result.tools } : undefined);
        scene.setTime(timeRef.current);
        scene.setView("iso");
      }
    },
    // Only on mount; later changes flow through the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const state = timeline && !timeline.empty ? timeline.stateAt(uiTime) : null;
  const setupDirty = JSON.stringify(job) !== JSON.stringify(appliedJob);
  const apply = () => current && runInterpretation(current, job);

  const step = (dir: 1 | -1) => {
    if (!timeline || timeline.empty) return;
    setPlaying(false);
    const t = timeRef.current;
    const i = timeline.indexAt(t);
    const eps = 1e-6;
    if (dir > 0) {
      const end = timeline.endOf(i);
      seek(t < end - eps ? end : timeline.endOf(Math.min(i + 1, timeline.moves.length - 1)));
    } else {
      const start = timeline.startOf(i);
      seek(t > start + eps ? start : timeline.startOf(Math.max(i - 1, 0)));
    }
  };

  return (
    <div className="app">
      <TopBar
        programs={programs}
        current={current}
        summary={result?.summary ?? null}
        busy={busy}
        onUpload={onUpload}
        onOpen={onOpenProgram}
      />
      <div className="workspace">
        <JobSetupPanel
          stock={stock}
          onStock={setStock}
          setup={setup}
          onSetup={setSetup}
          dirty={setupDirty}
          canApply={!!current && !busy}
          onApply={apply}
        />
        <main className="center">
          <Viewport
            onReady={onSceneReady}
            onUpload={onUpload}
            hasProgram={!!result}
            busy={busy}
            error={error}
            onDismissError={() => setError(null)}
            result={result}
            state={state}
            onView={(v) => sceneRef.current?.setView(v)}
            onZoom={(f) => sceneRef.current?.zoom(f)}
            onLayer={(layer, on) => sceneRef.current?.setLayerVisible(layer, on)}
          />
          <PlaybackBar
            disabled={!timeline || timeline.empty}
            playing={playing}
            time={uiTime}
            total={timeline?.total ?? 0}
            speed={speed}
            onPlay={() => {
              if (!timeline) return;
              if (timeRef.current >= timeline.total) seek(0);
              setPlaying(true);
            }}
            onPause={() => setPlaying(false)}
            onStop={() => {
              setPlaying(false);
              seek(0);
            }}
            onReset={() => {
              setPlaying(false);
              seek(0);
              sceneRef.current?.setView("iso");
            }}
            onStep={step}
            onSpeed={setSpeed}
            onSeek={(t) => {
              setPlaying(false);
              seek(t);
            }}
          />
        </main>
        <RightPanel
          result={result}
          setup={appliedJob.interpreter}
          overrides={toolOverrides}
          onOverride={(key, o) =>
            setToolOverrides((m) => {
              const next = { ...m };
              if (o) next[key] = o;
              else delete next[key];
              return next;
            })
          }
          dirty={setupDirty}
          canApply={!!current && !busy}
          onApply={apply}
          activeTool={state?.move.tool ?? null}
        />
      </div>
      <BottomPanel
        result={result}
        currentBlock={state?.move.block ?? null}
        onSeekBlock={(block) => {
          if (!timeline || timeline.empty) return;
          setPlaying(false);
          seek(timeline.startOf(timeline.moveForBlock(block)));
        }}
      />
    </div>
  );
}
