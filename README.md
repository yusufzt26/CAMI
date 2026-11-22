# CAMI · VMC G-code Verification (Zoom Technologies, Pune)

Browser-based verification software for 3-axis VMC programs. A CAM programmer uploads an NC
program, the backend interprets it like a FANUC controller would, and the browser plays the
toolpath back in 3D with a DRO, block list and diagnostics, before the program goes to the machine.

The software is being built in phases. **Phases 1 and 2 are built.**

| Phase | Scope | Status |
|---|---|---|
| 1 | G-code upload, FANUC interpreter, toolpath visualization, basic 3-axis simulation | **Done** |
| 2 | Real 3D material removal for milling and drilling, G41/G42 cutter compensation | **Done** |
| 3 | Tool library, tool holders, vice and fixture setup, STEP/STL import | Planned |
| 4 | Machine configuration, travel limits, collision detection | Planned |
| 5 | Machining analysis, PDF / Excel verification reports | Planned |

## What Phase 1 does

- **Upload** `.nc`, `.txt`, `.gcode`, `.tap` (drag-and-drop or button). Programs are stored in the database.
- **FANUC interpreter** (`backend/app/gcode`): G00–G03 (incl. helical, R and IJK arcs, G17/G18/G19),
  G04, G20/G21, G28, G40–G42, G43/G49, G52, G53, G54–G59, G73/G74/G76/G80–G89 canned cycles
  with G98/G99, K/L repeats and incremental mode, G90/G91, G92, G94/G95, M00–M09, M19, M29, M30, T-codes.
- **Safety-first diagnostics.** Nothing is silently ignored. Unknown codes, unsupported codes that change
  the path (G68 rotation, G51 scaling, G10, macros `#`/IF/GOTO, M98/M99 subprograms, A/B/C axes), missing
  feed, impossible arcs and other controller alarms **stop verification at that block**; the rest of the
  program is marked "not run". Other checks raise warnings or errors, e.g.:
  cutting with the spindle stopped, G84 with M04, Z moves before G43, H number ≠ tool, G41/G42 started on an arc,
  missing safety block, coordinates without a decimal point (FANUC DPI parameter), `/` block delete, cutter
  compensation not simulated, assumed G28 reference position.
- **3D viewport** (Three.js): machine table, stock envelope, toolpath coloured by move type (rapid, cutting,
  drill/tap/bore, reference return), cutter + holder + spindle, halt marker. Orthographic ISO / Top / Front / Side,
  rotate, pan, zoom, fit.
- **Playback**: play, pause, stop, reset, step forward/back one move, 0.5×–500× speed (1× = estimated machine time),
  timeline scrubbing, click a block to jump to it, live DRO (X Y Z, T, S, F, coolant, mode).
- **Summary**: estimated cycle time (cutting, rapid, tool change), distances, tool changes, holes, per-tool cut
  length/time, cutting extents.
- The status panel never claims full verification: tool/fixture geometry, machine limits and collisions are
  listed as *not checked* until their phases are built.

## What Phase 2 adds

- **Material removal** (`backend/app/material_removal`): a Z-map (height-field) stock model, the standard model for
  3-axis work. Cutter shapes: flat, ball nose, bull nose (corner radius), face mill, drill and spot drill (point
  angle), reamer, tap, counterbore. Up to 160 000 cells (about 0.43 mm on a 200 × 150 block).
- The browser runs the same algorithm (`frontend/src/sim/zmap.ts`) so the stock is **cut live during playback**,
  coloured by the tool that cut each surface. Scrubbing backwards restores checkpoints, so any point in the program
  can be inspected. The browser result matches the backend exactly (checked on the demo program).
- **Tool sizes from CAM comments**: `(T2 D16 FLAT END MILL)`, `(T1 D=10. CR=1. - BULL)`, `T4 M06 (M12 X 1.75 TAP)`.
  Tools without a size are flagged and can be set in the tool panel.
- **New checks**: rapid (G00) moves that cut material (error), cutting material with the spindle stopped (error), tool tip
  below the stock bottom (warning), assumed tool sizes (warning). Summary adds removed volume, volume per tool,
  air-cutting time and deepest point.
- **G41/G42 cutter radius compensation** in the XY plane: FANUC type A start-up, intersection at inside corners,
  arcs at outside corners, offset arcs, Z moves inside compensation, alarm when the radius is too large for an
  inside arc or corner. The D value is taken as the radius of the tool with the same number, or set to
  *wear only* when the CAM output is already the cutter centre path.

## Architecture

```
backend/app/
  gcode/              G-code interpreter (Phase 1)
    lexer.py          controller-neutral tokenizer (comments, N/O numbers, macro detection)
    controllers/      dialect tables: fanuc.py now; Siemens / Mitsubishi plug in here
    interpreter.py    modal state machine -> motion list + diagnostics
    geometry.py       arcs, dog-leg rapids
    cutter_comp.py    G41/G42 offset path
  material_removal/   Z-map stock engine, cutter profiles, tool hints from comments (Phase 2)
  collision/          collision engine (Phase 4, empty)
  api/programs.py     REST API
  db.py               SQLAlchemy models (PostgreSQL in production, SQLite for local dev)
frontend/src/
  sim/timeline.ts     time -> machine state (kinematics only)
  sim/zmap.ts         browser copy of the Z-map engine; stockPlayback.ts keeps it in step with playback
  viewer/SceneView.ts Three.js scene, independent of React
  components/         light industrial UI: job setup (left), verification/tools/machine (right),
                      G-code blocks / diagnostics / summary (bottom)
```

The interpreter, material-removal and collision engines are separate modules. The interpreter outputs a
list of motions in the G54 frame (mm, arcs tessellated to 5 µm chord error); later engines consume that list.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/programs` | upload (multipart `file`) |
| GET | `/api/programs` | recent programs |
| GET | `/api/programs/{id}` | program + text |
| POST | `/api/programs/{id}/interpret` | run the interpreter with job settings (work offsets, rapid rate, DPI mode, ...) |
| GET | `/api/controllers/fanuc` | supported-code table |

## Running locally

```bash
# backend (Python 3.11+)
python -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/uvicorn app.main:app --reload --port 8000

# frontend (Node 20+), in another terminal
cd frontend && npm install && npm run dev     # http://localhost:5173
```

Without `DATABASE_URL` the backend uses SQLite in `backend/data/`. Tests: `cd backend && ../.venv/bin/pytest`.

Try `samples/mould_plate_demo.nc` (face, pocket with G41, helical bore, peck drilling, rigid tapping) and
`samples/unsafe_examples.nc` (stops at G68).

## Office server deployment

```bash
POSTGRES_PASSWORD=<choose one> docker compose up -d --build
```

Then open `http://<server-ip>:8000` in Google Chrome. User login with administrator/programmer roles is
planned alongside the machine library (Phase 4) and is not in Phase 1, so keep the server on the office
network only.
