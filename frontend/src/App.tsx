import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_MODE, clearPrograms, getProgramText, interpretProgram, listPrograms, uploadProgram, type JobSetup } from "./api";
import { type ProgramSetInfo, SetRunner } from "./setRunner";
import { runInBrowser } from "./engineRun";
import { OptimiserView } from "./optimiser/OptimiserView";
import { LEVELS } from "./optimiser/analysis";
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

  // Program set (all programs of one zip, run in order with the stock carried over).
  const [programSet, setProgramSet] = useState<ProgramSetInfo | null>(null);
  const [carry, setCarry] = useState(true);
  const [setVersion, setSetVersion] = useState(0);
  const runnerRef = useRef<SetRunner | null>(null);

  // Module tabs: CAMI Simulator | NC Optimiser.
  const [view, setView] = useState<"sim" | "opt">("sim");
  const [loadColors, setLoadColors] = useState(false);
  const [computedLoad, setComputedLoad] = useState<{ of: InterpretResponse; res: InterpretResponse } | null>(null);
  const [optBusy, setOptBusy] = useState<string | null>(null);
  const carryRef = useRef(true);
  carryRef.current = carry;

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [uiTime, setUiTime] = useState(0);
  const timeRef = useRef(0);
  const sceneRef = useRef<SceneView | null>(null);

  const timeline = useMemo(() => (result ? new Timeline(result.moves) : null), [result]);

  const [notice, setNotice] = useState<string | null>(null);

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
      const runner = runnerRef.current;
      const idx = runner && carryRef.current ? runner.indexOf(prog.id) : -1;
      let res: InterpretResponse;
      if (runner && idx >= 0) {
        // Set mode: earlier programs of the set run first so this one starts from their stock.
        const n = runner.info.ids.length;
        res = await runner.run(idx, j, getProgramText, (i) => setBusy(`Simulating the set: ${i + 1} / ${n} · ${runner.info.filenames[i]} (stock carried over)…`));
        setBusy(`Simulating ${prog.filename} (${idx + 1} / ${n} in the set)…`);
        setSetVersion((v) => v + 1);
      } else {
        res = await interpretProgram(prog.id, j);
      }
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
    scene.setProgram(timeline, result ? { grid: result.stock.grid, tools: result.tools, start: result.startStock } : undefined);
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
        const { metas, stock: found } = await uploadProgram(file);
        let j = job;
        const notes: string[] = [];
        if (metas.length > 1) {
          const info: ProgramSetInfo = { name: file.name, ids: metas.map((m) => m.id), filenames: metas.map((m) => m.filename) };
          runnerRef.current = new SetRunner(info);
          setProgramSet(info);
          setSetVersion((v) => v + 1);
          notes.push(
            `${metas.length} programs found in ${file.name}. They form a program set: each one starts from the stock the earlier ones left (Program set tab). Showing ${metas[0].filename}.`,
          );
        }
        if (found) {
          const next: StockSetup = { ...stock, size: found.size, origin: found.origin, topZ: found.topZ, allowance: 0 };
          setStock(next);
          j = { ...job, stock: next };
          notes.push(`Stock set from ${found.source}: ${found.size.join(" × ")} mm, part zero at the ${found.origin.replace(/-/g, " ").replace("center", "centre")}${found.topZ ? ` (top Z${found.topZ})` : ""}. Check it in Job & stock setup.`);
        }
        setNotice(notes.join(" ") || null);
        setCurrent(metas[0]);
        await runInterpretation(metas[0], j);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      }
    },
    [runInterpretation, job, stock],
  );

  const openById = (id: number) => {
    const meta = programs.find((p) => p.id === id);
    if (!meta) return;
    setCurrent(meta);
    runInterpretation(meta, job);
  };

  const runWholeSet = async () => {
    const runner = runnerRef.current;
    if (!runner || busy) return;
    const n = runner.info.ids.length;
    setError(null);
    setPlaying(false);
    try {
      await runner.runAll(job, getProgramText, (i) => {
        setBusy(`Simulating the set: ${i + 1} / ${n} · ${runner.info.filenames[i]}…`);
        setSetVersion((v) => v + 1);
      });
      setAppliedJob(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setSetVersion((v) => v + 1);
    }
  };

  const onClear = async () => {
    setPlaying(false);
    try {
      await clearPrograms();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    runnerRef.current = null;
    setProgramSet(null);
    setCurrent(null);
    setResult(null);
    setNotice(null);
    setError(null);
    const fresh = { interpreter: defaultInterpreterSetup(), stock: defaultStock(), tools: {} };
    setSetup(fresh.interpreter);
    setStock(fresh.stock);
    setToolOverrides({});
    setAppliedJob(fresh);
    setPrograms(await listPrograms().catch(() => []));
  };

  const onOpenProgram = useCallback(
    (id: number) => {
      const meta = programs.find((p) => p.id === id);
      if (!meta) return;
      setCurrent(meta);
      setNotice(null);
      runInterpretation(meta, job);
    },
    [programs, runInterpretation, job],
  );

  // Load the program list; the standalone preview opens its demo program straight away.
  useEffect(() => {
    listPrograms()
      .then((list) => {
        setPrograms(list);
        if (LOCAL_MODE && list.length) {
          const first = list.find((p) => p.filename === "mould_plate_demo.nc") ?? list[0];
          setCurrent(first);
          runInterpretation(first, job);
        }
      })
      .catch(() => setPrograms([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSceneReady = useCallback(
    (scene: SceneView | null) => {
      sceneRef.current = scene;
      if (scene) {
        scene.setStock(stock);
        scene.setProgram(timeline, result ? { grid: result.stock.grid, tools: result.tools, start: result.startStock } : undefined);
        scene.setTime(timeRef.current);
        scene.setView("iso");
      }
    },
    // Only on mount; later changes flow through the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The optimiser needs the per-move load from the browser engine. Server results do not carry it,
  // so the same program is run in the browser (identical engine) when the optimiser tab is opened.
  const optResult = result?.load ? result : computedLoad && computedLoad.of === result ? computedLoad.res : null;
  const optTimeline = useMemo(() => (optResult ? (optResult === result ? timeline : new Timeline(optResult.moves)) : null), [optResult, result, timeline]);
  useEffect(() => {
    if (view !== "opt" || !result || result.load || !current || (computedLoad && computedLoad.of === result)) return;
    let cancelled = false;
    setOptBusy("Analysing cutting load…");
    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 30));
        const text = await getProgramText(current.id);
        const res = runInBrowser(text, appliedJob, result.program, result.startStock);
        if (!cancelled) setComputedLoad({ of: result, res });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setOptBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, result]); // eslint-disable-line react-hooks/exhaustive-deps

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
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        onClear={onClear}
        view={view}
        onView={setView}
      />
      <div className="opt-pane" hidden={view !== "opt"}>
        <OptimiserView
          result={optResult}
          timeline={optTimeline}
          busy={optBusy ?? busy}
          error={error}
          loadColors={loadColors}
          onLoadColors={(on, analysis) => {
            setLoadColors(on);
            sceneRef.current?.setLoadColors(on && analysis ? analysis.level : null, LEVELS.map((l) => l.color));
          }}
          onShowInSimulator={(i) => {
            setView("sim");
            setPlaying(false);
            if (timeline && !timeline.empty) seek(timeline.startOf(Math.min(i, timeline.moves.length - 1)));
          }}
        />
      </div>
      <div className="workspace" hidden={view !== "sim"}>
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
            loadLegend={loadColors ? LEVELS : null}
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
        hidden={view !== "sim"}
        programSet={
          programSet && runnerRef.current
            ? {
                info: programSet,
                rows: runnerRef.current.rows,
                version: setVersion,
                carry,
                onCarry: (on: boolean) => {
                  carryRef.current = on;
                  setCarry(on);
                  if (current) runInterpretation(current, job);
                },
                onRunAll: runWholeSet,
                onOpen: openById,
                currentId: current?.id ?? null,
                busy: !!busy,
              }
            : null
        }
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
