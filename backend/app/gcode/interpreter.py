"""Modal G-code interpreter.

Turns lexed blocks into a list of machine motions (in the G54 work frame, mm)
plus diagnostics. It is deliberately conservative: anything it cannot interpret
with confidence is reported, and anything that could change where the tool goes
stops interpretation at that block ("halt") rather than being skipped.

This module knows nothing about stock, tools geometry, fixtures or machine
kinematics. Material removal and collision checking are separate modules that
consume the motion list.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .controllers import ControllerDialect, Support, get_dialect
from .geometry import (
    ArcError,
    PLANE_AXES,
    arc_center_from_offsets,
    arc_center_from_radius,
    build_arc,
    dogleg_points,
    polyline_length,
)
from .lexer import Block, Word, tokenize
from .model import WCS_CODES, Diagnostic, InterpreterSettings, Move

AXES = ("X", "Y", "Z")
POSITION_LETTERS = {"X", "Y", "Z", "I", "J", "K", "R", "Q"}
CYCLE_OPS = {
    "G73": "drill",
    "G81": "drill",
    "G82": "drill",
    "G83": "drill",
    "G74": "tap",
    "G84": "tap",
    "G76": "bore",
    "G85": "bore",
    "G86": "bore",
    "G88": "bore",
    "G89": "bore",
}
MAX_DIAGS_PER_CODE = 25
STARTUP_GROUPS = {
    "distance": "G90/G91",
    "plane": "G17/G18/G19",
    "units": "G20/G21",
    "wcs": "G54-G59",
}


class Halt(Exception):
    pass


@dataclass
class State:
    pos: list[float]  # machine coordinates, mm
    units: str = "mm"
    distance: str = "G90"
    plane: str = "G17"
    motion: str | None = None
    cycle: str | None = None  # active canned cycle, None = G80
    cycle_return: str = "G98"
    cycle_initial_z: float | None = None  # work Z
    cycle_r: float | None = None  # program value (abs or inc)
    cycle_z: float | None = None
    cycle_q: float | None = None
    cycle_p: float | None = None
    feed: float | None = None  # in mm/min (G94) or mm/rev (G95)
    feed_mode: str = "G94"
    spindle_speed: float = 0.0
    spindle_dir: int = 0
    coolant: bool = False
    selected_tool: int | None = None
    tool: int | None = None
    h_offset: int | None = None
    d_offset: int | None = None
    cutter_comp: str = "G40"
    length_comp: bool = False
    wcs: str = "G54"
    g52: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    g92: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    rigid_tap: bool = False
    ended: bool = False


@dataclass
class InterpretResult:
    blocks: list[dict]
    moves: list[dict]
    diagnostics: list[dict]
    summary: dict
    settings: dict


class Interpreter:
    def __init__(self, settings: InterpreterSettings | None = None):
        self.settings = settings or InterpreterSettings()
        self.dialect: ControllerDialect = get_dialect(self.settings.controller)
        self.moves: list[Move] = []
        self.diags: list[Diagnostic] = []
        self._diag_counts: Counter = Counter()
        self._once: set[str] = set()
        self.halted_at: int | None = None
        self._explicit_groups: set[str] = set()
        self._motion_seen = False
        self._no_decimal: list[int] = []
        self._tool_needs_g43: set[int] = set()
        self.executed_blocks = 0

    # ------------------------------------------------------------------ utils
    def diag(self, severity, code, message, block: Block | None = None, halt=False, once_key=None):
        if once_key is not None:
            if once_key in self._once:
                return
            self._once.add(once_key)
        self._diag_counts[code] += 1
        if self._diag_counts[code] > MAX_DIAGS_PER_CODE and not halt:
            return
        self.diags.append(
            Diagnostic(
                severity=severity,
                code=code,
                message=message,
                line=block.line if block else None,
                block=block.index if block else None,
                halt=halt,
            )
        )
        if halt:
            raise Halt(message)

    def offset(self, st: State) -> list[float]:
        w = self.settings.work_offsets.get(st.wcs, [0.0, 0.0, 0.0])
        return [w[i] + st.g52[i] + st.g92[i] for i in range(3)]

    def to_work(self, st: State, machine: list[float]) -> list[float]:
        off = self.offset(st)
        return [machine[i] - off[i] for i in range(3)]

    def to_machine(self, st: State, work: list[float]) -> list[float]:
        off = self.offset(st)
        return [work[i] + off[i] for i in range(3)]

    def to_display(self, machine: list[float]) -> list[float]:
        g54 = self.settings.work_offsets.get("G54", [0.0, 0.0, 0.0])
        return [machine[i] - g54[i] for i in range(3)]

    def scale(self, st: State) -> float:
        return 25.4 if st.units == "inch" else 1.0

    def value(self, st: State, w: Word, block: Block) -> float:
        """Convert a position-type word to mm, honouring the decimal-point mode."""
        v = w.value
        if w.letter in POSITION_LETTERS and not w.has_decimal_point and v != 0:
            self._no_decimal.append(block.line)
            if self.settings.decimal_mode == "least_increment":
                v = v * (0.0001 if st.units == "inch" else 0.001)
        return v * self.scale(st)

    def feed_value(self, st: State, w: Word) -> float:
        return w.value * self.scale(st)

    # ------------------------------------------------------------ main entry
    def run(self, text: str) -> InterpretResult:
        blocks = tokenize(text)
        s = self.settings
        st = State(pos=list(s.reference_position), units=s.initial_units)
        block_status: dict[int, str] = {}
        for block in blocks:
            if st.ended:
                if block.words:
                    block_status[block.index] = "after_end"
                    self.diag(
                        "info",
                        "AFTER_END",
                        "Blocks after M02/M30 were not simulated.",
                        block,
                        once_key="after_end",
                    )
                continue
            try:
                executed = self.execute(block, st)
                block_status[block.index] = "executed" if executed else "skipped"
                if executed:
                    self.executed_blocks += 1
            except Halt:
                block_status[block.index] = "halted"
                self.halted_at = block.index
                break
        if self.halted_at is not None:
            for b in blocks[self.halted_at + 1 :]:
                block_status[b.index] = "not_run"

        self._finish(st)
        summary = self._summary(blocks, st)
        block_dicts = [
            {
                "index": b.index,
                "line": b.line,
                "text": b.text,
                "status": block_status.get(b.index, "not_run"),
            }
            for b in blocks
        ]
        return InterpretResult(
            blocks=block_dicts,
            moves=[m.to_dict() for m in self.moves],
            diagnostics=[d.to_dict() for d in self.diags],
            summary=summary,
            settings=self._settings_dict(),
        )

    def _settings_dict(self):
        s = self.settings
        return {
            "controller": s.controller,
            "controller_name": self.dialect.name,
            "initial_units": s.initial_units,
            "work_offsets": s.work_offsets,
            "reference_position": s.reference_position,
            "rapid_rate": s.rapid_rate,
            "max_feed": s.max_feed,
            "decimal_mode": s.decimal_mode,
            "rapid_mode": s.rapid_mode,
            "block_delete_switch": s.block_delete_switch,
        }

    # ---------------------------------------------------------------- blocks
    def execute(self, block: Block, st: State) -> bool:
        if block.lex_errors:
            self.diag("error", "SYNTAX", f"{'; '.join(block.lex_errors)}. Verification stopped.", block, halt=True)
        if block.macro:
            self.diag(
                "error",
                "MACRO",
                "Custom macro / variable statement (#, IF, GOTO, WHILE) is not supported yet. "
                "Verification stopped because the tool path after this point cannot be known.",
                block,
                halt=True,
            )
        if not block.words:
            return False
        if block.block_delete:
            if self.settings.block_delete_switch:
                self.diag("info", "BLOCK_DELETE", "Block skipped: Block Delete switch is ON.", block)
                return False
            self.diag(
                "warning",
                "BLOCK_DELETE",
                "Block starts with '/'. Simulated with the Block Delete switch OFF (block executed). "
                "Check the operator panel setting on the machine.",
                block,
            )

        # --- classify words -------------------------------------------------
        g_codes: list[str] = []
        m_codes: list[str] = []
        seen_letters: dict[str, Word] = {}
        for w in block.words:
            if w.letter == "G":
                g_codes.append(w.code)
                continue
            if w.letter == "M":
                m_codes.append(w.code)
                continue
            if w.letter in self.dialect.foreign_axes:
                self.diag(
                    "error",
                    "FOREIGN_AXIS",
                    f"Address {w.letter} refers to an axis that a 3-axis VMC does not have. Verification stopped.",
                    block,
                    halt=True,
                )
            if w.letter not in self.dialect.letters:
                self.diag(
                    "error",
                    "UNKNOWN_ADDRESS",
                    f"Unknown address '{w.letter}{w.raw}'. Verification stopped.",
                    block,
                    halt=True,
                )
            if w.letter in seen_letters:
                self.diag(
                    "error",
                    "DUPLICATE_ADDRESS",
                    f"Address {w.letter} appears twice in one block (controller alarm). Verification stopped.",
                    block,
                    halt=True,
                )
            seen_letters[w.letter] = w

        groups: dict[str, str] = {}
        for code in g_codes + m_codes:
            spec = self.dialect.lookup(code)
            if spec is None:
                self.diag(
                    "error",
                    "UNKNOWN_CODE",
                    f"{code} is not a recognised {self.dialect.name} code. It could affect machining, "
                    "so verification stopped.",
                    block,
                    halt=True,
                )
            if spec.support == Support.UNSUPPORTED:
                extra = f" {spec.note}" if spec.note else ""
                self.diag(
                    "error",
                    "UNSUPPORTED_CODE",
                    f"{code} ({spec.description}) is not supported by this simulator yet.{extra} "
                    "Verification stopped at this block.",
                    block,
                    halt=True,
                )
            if spec.group in groups and spec.group not in ("nonmodal",) and code.startswith("G"):
                self.diag(
                    "error",
                    "MODAL_CONFLICT",
                    f"{groups[spec.group]} and {code} are in the same modal group ({spec.group}). Verification stopped.",
                    block,
                    halt=True,
                )
            groups.setdefault(spec.group, code)
            if spec.support == Support.NO_EFFECT:
                self.diag("info", "NO_EFFECT", f"{code} ({spec.description}) has no effect on the simulated path.", block, once_key=f"noeffect:{code}")
            if spec.support == Support.LIMITED and spec.note and code not in ("G28", "G53", "G41", "G42"):
                self.diag("warning", "LIMITED", f"{code} ({spec.description}): {spec.note}", block, once_key=f"limited:{code}")

        axis_nonmodal = [c for c in g_codes if c in ("G28", "G53", "G92", "G52", "G4")]
        if len(axis_nonmodal) > 1:
            self.diag(
                "error",
                "MODAL_CONFLICT",
                f"{' and '.join(axis_nonmodal)} cannot be combined in one block. Verification stopped.",
                block,
                halt=True,
            )

        for grp in STARTUP_GROUPS:
            if grp in groups:
                self._explicit_groups.add(grp)

        # --- modal settings (order follows FANUC execution) ------------------
        if "units" in groups:
            new_units = "inch" if groups["units"] == "G20" else "mm"
            if new_units != st.units and self._motion_seen:
                self.diag("warning", "UNITS_CHANGE", f"Units changed to {new_units} after motion had started.", block)
            st.units = new_units
        if "plane" in groups:
            st.plane = groups["plane"]
        if "distance" in groups:
            st.distance = groups["distance"]
        if "feed_mode" in groups:
            st.feed_mode = groups["feed_mode"]
        if "cycle_return" in groups:
            st.cycle_return = groups["cycle_return"]
        if "F" in seen_letters:
            f = self.feed_value(st, seen_letters["F"])
            if f <= 0:
                self.diag("error", "FEED_ZERO", "F0 / negative feed rate programmed.", block)
            st.feed = f
        if "S" in seen_letters:
            st.spindle_speed = seen_letters["S"].value
        if "T" in seen_letters:
            st.selected_tool = int(seen_letters["T"].value)
        if "spindle" in groups:
            st.spindle_dir = {"M3": 1, "M4": -1, "M5": 0}[groups["spindle"]]
            if st.spindle_dir != 0 and st.spindle_speed <= 0:
                self.diag("warning", "SPINDLE_NO_SPEED", f"{groups['spindle']} with no spindle speed (S) programmed.", block)
        if "coolant" in groups:
            st.coolant = groups["coolant"] != "M9"
        if "rigid_tap" in groups:
            st.rigid_tap = True
        if "wcs" in groups:
            st.wcs = groups["wcs"]
            off = self.settings.work_offsets.get(st.wcs, [0, 0, 0])
            if st.wcs != "G54" and off == self.settings.work_offsets.get("G54"):
                self.diag(
                    "warning",
                    "WCS_SAME",
                    f"{st.wcs} is used but its offset equals G54. Enter the {st.wcs} offset in Job Setup if it differs.",
                    block,
                    once_key=f"wcs_same:{st.wcs}",
                )

        motion_code = groups.get("motion")
        if "cutter_comp" in groups:
            new_comp = groups["cutter_comp"]
            eff_motion = motion_code or st.motion
            if new_comp != st.cutter_comp and eff_motion in ("G2", "G3") and self._has_axes(seen_letters):
                self.diag(
                    "error",
                    "COMP_ON_ARC",
                    f"Cutter compensation {new_comp} started/cancelled in a G02/G03 block (controller alarm). "
                    "Verification stopped.",
                    block,
                    halt=True,
                )
            if new_comp in ("G41", "G42"):
                if "D" in seen_letters:
                    st.d_offset = int(seen_letters["D"].value)
                elif st.d_offset is None:
                    self.diag("warning", "COMP_NO_D", f"{new_comp} without a D offset number.", block)
                self.diag(
                    "warning",
                    "CUTTER_COMP",
                    f"{new_comp} active (D{st.d_offset if st.d_offset is not None else '?'}): the programmed path is shown. "
                    "The real cutter centre is offset by the D radius, which is not simulated in this phase.",
                    block,
                    once_key=f"comp:{block.index}",
                )
            st.cutter_comp = new_comp
        elif "D" in seen_letters:
            st.d_offset = int(seen_letters["D"].value)

        if "length_comp" in groups:
            if groups["length_comp"] == "G43":
                st.length_comp = True
                if "H" in seen_letters:
                    st.h_offset = int(seen_letters["H"].value)
                else:
                    self.diag("warning", "G43_NO_H", "G43 without an H number: the active H offset is used.", block)
                if st.tool is not None:
                    self._tool_needs_g43.discard(st.tool)
                if st.h_offset is not None and st.tool is not None and st.h_offset != st.tool:
                    self.diag(
                        "warning",
                        "H_MISMATCH",
                        f"G43 H{st.h_offset} while T{st.tool} is in the spindle. Check the length offset number.",
                        block,
                    )
            else:
                st.length_comp = False
        elif "H" in seen_letters:
            st.h_offset = int(seen_letters["H"].value)

        # --- tool change ----------------------------------------------------
        if "toolchange" in groups:
            self._tool_change(block, st)

        # --- G52 / G92 (coordinate settings using axis words) ---------------
        if "G52" in g_codes:
            for i, a in enumerate(AXES):
                if a in seen_letters:
                    st.g52[i] = self.value(st, seen_letters[a], block)
            return True
        if "G92" in g_codes:
            machine = st.pos
            for i, a in enumerate(AXES):
                if a in seen_letters:
                    wcs = self.settings.work_offsets.get(st.wcs, [0, 0, 0])
                    st.g92[i] = machine[i] - wcs[i] - st.g52[i] - self.value(st, seen_letters[a], block)
            self.diag("warning", "G92", "G92 coordinate shift applied. Confirm it matches the machine setup.", block)
            return True
        if "G4" in g_codes:
            self._dwell(block, st, seen_letters)
            self._stops(block, st, groups)
            return True

        # --- motion -----------------------------------------------------------
        if motion_code:
            st.motion = motion_code
            if st.cycle:
                st.cycle = None
        cycle_code = groups.get("cycle")
        if cycle_code == "G80":
            st.cycle = None
            st.cycle_r = st.cycle_z = st.cycle_q = st.cycle_p = None
        elif cycle_code:
            if st.cycle is None:
                st.cycle_initial_z = self.to_work(st, st.pos)[2]
            st.cycle = cycle_code
            if motion_code:
                self.diag(
                    "warning",
                    "CYCLE_WITH_MOTION",
                    f"{motion_code} and {cycle_code} in the same block; the canned cycle takes effect.",
                    block,
                )

        if "G28" in g_codes:
            self._reference_return(block, st, seen_letters)
        elif "G53" in g_codes:
            self._machine_move(block, st, seen_letters, motion_code)
        elif st.cycle and (self._has_axes(seen_letters, xy_only=True) or (cycle_code and cycle_code != "G80" and self._has_axes(seen_letters))):
            self._update_cycle_params(block, st, seen_letters)
            self._cycle(block, st, seen_letters)
        elif st.cycle and cycle_code and cycle_code != "G80":
            # Cycle defined without a hole position: just store the parameters.
            self._update_cycle_params(block, st, seen_letters)
        elif self._has_axes(seen_letters, include_arc=True):
            self._motion(block, st, seen_letters)

        self._stops(block, st, groups)
        return True

    # ------------------------------------------------------------------ parts
    @staticmethod
    def _has_axes(letters: dict, xy_only=False, include_arc=False) -> bool:
        keys = ("X", "Y") if xy_only else AXES
        if any(k in letters for k in keys):
            return True
        if include_arc and any(k in letters for k in ("I", "J", "K", "R")):
            return True
        return False

    def _check_startup(self, block):
        if self._motion_seen:
            return
        self._motion_seen = True
        missing = [label for grp, label in STARTUP_GROUPS.items() if grp not in self._explicit_groups]
        if missing:
            self.diag(
                "warning",
                "NO_SAFETY_BLOCK",
                f"No {', '.join(missing)} before the first move. The simulator assumed power-on defaults "
                "(G90, G17, G21/initial units, G54); the machine will use whatever modal state is active.",
                block,
            )

    def _target(self, block: Block, st: State, letters: dict) -> list[float]:
        work = self.to_work(st, st.pos)
        for i, a in enumerate(AXES):
            if a in letters:
                v = self.value(st, letters[a], block)
                work[i] = work[i] + v if st.distance == "G91" else v
        return self.to_machine(st, work)

    def _emit(self, kind, op, block, start, end, duration, length, st, feed=None, points=None, note=None):
        self.moves.append(
            Move(
                kind=kind,
                op=op,
                block=block.index,
                line=block.line,
                start=self.to_display(start),
                end=self.to_display(end),
                duration=duration,
                length=length,
                feed=feed,
                tool=st.tool,
                spindle=st.spindle_speed * st.spindle_dir,
                coolant=st.coolant,
                points=[self.to_display(p) for p in points] if points else None,
                note=note,
            )
        )

    def _rapid(self, block, st, target, op="position", note=None):
        start = list(st.pos)
        if math.dist(start, target) < 1e-9:
            return
        dmax = max(abs(target[i] - start[i]) for i in range(3))
        duration = dmax / self.settings.rapid_rate * 60.0
        points = None
        if self.settings.rapid_mode == "dogleg":
            points = dogleg_points(start, target)
            length = polyline_length(points)
            if len(points) <= 2:
                points = None
        else:
            length = math.dist(start, target)
        self._emit("rapid", op, block, start, target, duration, length, st, feed=self.settings.rapid_rate, points=points, note=note)
        st.pos = list(target)

    def _feed_rate(self, block, st) -> float:
        if st.feed is None or st.feed <= 0:
            self.diag(
                "error",
                "NO_FEED",
                "Cutting move without a feed rate (F). The controller would alarm. Verification stopped.",
                block,
                halt=True,
            )
        if st.feed_mode == "G95":
            if st.spindle_speed <= 0 or st.spindle_dir == 0:
                self.diag(
                    "error",
                    "G95_NO_SPINDLE",
                    "Feed per revolution (G95) with the spindle stopped. Verification stopped.",
                    block,
                    halt=True,
                )
            return st.feed * st.spindle_speed
        return st.feed

    def _cut_checks(self, block, st, op="mill"):
        self._check_startup(block)
        if st.spindle_dir == 0 or st.spindle_speed <= 0:
            self.diag(
                "error",
                "SPINDLE_OFF_CUT",
                "Cutting move with the spindle stopped (no M03/M04 or S0).",
                block,
            )
        if st.tool is None:
            self.diag(
                "warning",
                "NO_TOOL",
                "Cutting starts without a T/M06 tool change; the tool in the spindle is unknown.",
                block,
                once_key="no_tool",
            )

    def _z_checks(self, block, st, start, end):
        if st.tool is not None and st.tool in self._tool_needs_g43 and abs(end[2] - start[2]) > 1e-9:
            self._tool_needs_g43.discard(st.tool)
            self.diag(
                "warning",
                "NO_G43",
                f"Z moves with T{st.tool} before G43 tool length compensation is active.",
                block,
            )

    def _motion(self, block, st, letters):
        mode = st.motion
        if mode is None:
            self.diag(
                "warning",
                "NO_MOTION_MODE",
                "Axis move before any G00/G01/G02/G03: the FANUC power-on default G00 (rapid) was assumed.",
                block,
                once_key="no_motion_mode",
            )
            mode = st.motion = "G0"
        target = self._target(block, st, letters)
        start = list(st.pos)
        if mode == "G0":
            self._check_startup(block)
            self._z_checks(block, st, start, target)
            self._rapid(block, st, target)
            return
        feed = self._feed_rate(block, st)
        self._cut_checks(block, st)
        self._z_checks(block, st, start, target)
        if feed > self.settings.max_feed:
            self.diag("warning", "FEED_HIGH", f"Feed {feed:.0f} mm/min exceeds the configured maximum {self.settings.max_feed:.0f}.", block)
        if mode == "G1":
            length = math.dist(start, target)
            if length < 1e-9:
                return
            self._emit("feed", "mill", block, start, target, length / feed * 60.0, length, st, feed=feed)
            st.pos = target
            return
        # Arcs
        clockwise = mode == "G2"
        plane = st.plane
        a, b, n = PLANE_AXES[plane]
        offset_letters = {"G17": ("I", "J"), "G18": ("K", "I"), "G19": ("J", "K")}[plane]
        try:
            if "R" in letters:
                r = self.value(st, letters["R"], block)
                center = arc_center_from_radius(start, target, r, clockwise, plane)
                arc = build_arc(start, target, center, clockwise, plane, self.settings.chord_tolerance, full_circle_allowed=False)
            else:
                if not any(l in letters for l in offset_letters):
                    if any(l in letters for l in ("I", "J", "K")):
                        self.diag(
                            "error",
                            "ARC_PLANE",
                            f"Arc centre words do not match the active plane {plane} (expects {'/'.join(offset_letters)}). "
                            "Verification stopped.",
                            block,
                            halt=True,
                        )
                    self.diag("error", "ARC_NO_CENTER", "G02/G03 without R or I/J/K. Verification stopped.", block, halt=True)
                offs = [self.value(st, letters[l], block) if l in letters else 0.0 for l in offset_letters]
                center = arc_center_from_offsets(start, offs, plane)
                arc = build_arc(start, target, center, clockwise, plane, self.settings.chord_tolerance)
                if arc.radius_error > self.settings.arc_radius_tolerance:
                    self.diag(
                        "error",
                        "ARC_RADIUS",
                        f"Arc start and end radii differ by {arc.radius_error:.4f} mm (limit {self.settings.arc_radius_tolerance} mm). "
                        "The controller would alarm. Verification stopped.",
                        block,
                        halt=True,
                    )
                elif arc.radius_error > 0.002:
                    self.diag("warning", "ARC_RADIUS", f"Arc start/end radii differ by {arc.radius_error:.4f} mm.", block)
        except ArcError as exc:
            self.diag("error", "ARC_INVALID", f"{exc}. Verification stopped.", block, halt=True)
            return
        self._emit(
            "arc",
            "mill",
            block,
            start,
            target,
            arc.length / feed * 60.0,
            arc.length,
            st,
            feed=feed,
            points=arc.points,
            note=f"{'CW' if clockwise else 'CCW'} R{arc.radius:.3f}",
        )
        st.pos = target

    def _dwell(self, block, st, letters):
        if "P" in letters:
            seconds = letters["P"].value / 1000.0
        elif "X" in letters:
            w = letters["X"]
            seconds = w.value if w.has_decimal_point or self.settings.decimal_mode == "calculator" else w.value / 1000.0
        else:
            seconds = 0.0
        self._emit("dwell", "none", block, st.pos, st.pos, seconds, 0.0, st, note=f"Dwell {seconds:g} s")

    def _stops(self, block, st, groups):
        code = groups.get("stop")
        if not code:
            return
        if code in ("M0", "M1"):
            self._emit("stop", "none", block, st.pos, st.pos, 0.0, 0.0, st, note="Program stop" if code == "M0" else "Optional stop")
        else:
            st.ended = True
            if st.spindle_dir != 0:
                st.spindle_dir = 0
            if st.cutter_comp != "G40":
                self.diag("warning", "COMP_AT_END", "Program ends with cutter compensation still active.", block)

    def _tool_change(self, block, st):
        if st.selected_tool is None:
            self.diag("error", "M6_NO_T", "M06 without a T number selected. Verification stopped.", block, halt=True)
        if st.cutter_comp != "G40":
            self.diag("warning", "M6_COMP", "Tool change with cutter compensation active.", block)
        if st.cycle:
            self.diag("warning", "M6_CYCLE", "Tool change with a canned cycle still active (no G80).", block)
        prev = st.tool
        st.tool = st.selected_tool
        st.length_comp = False if prev != st.tool else st.length_comp
        if st.tool is not None:
            self._tool_needs_g43.add(st.tool)
        self._emit(
            "toolchange",
            "none",
            block,
            st.pos,
            st.pos,
            self.settings.tool_change_time,
            0.0,
            st,
            note=f"T{prev if prev is not None else '-'} -> T{st.tool}",
        )
        self.diag(
            "info",
            "TOOL_CHANGE_POS",
            "Tool-change position and clearance are not checked until a machine is configured (Phase 4).",
            block,
            once_key="tc_pos",
        )

    def _reference_return(self, block, st, letters):
        axes = [i for i, a in enumerate(AXES) if a in letters]
        if not axes:
            self.diag("warning", "G28_NO_AXIS", "G28 without axis words does nothing.", block)
            return
        self.diag(
            "warning",
            "REFERENCE_ASSUMED",
            f"G28 reference position assumed at machine X{self.settings.reference_position[0]:g} "
            f"Y{self.settings.reference_position[1]:g} Z{self.settings.reference_position[2]:g}. "
            "Set the real position in Job Setup or the machine configuration.",
            block,
            once_key="ref_assumed",
        )
        intermediate = self._target(block, st, {AXES[i]: letters[AXES[i]] for i in axes})
        self._rapid(block, st, intermediate, op="reference", note="G28 intermediate point")
        ref = list(st.pos)
        for i in axes:
            ref[i] = self.settings.reference_position[i]
        self._rapid(block, st, ref, op="reference", note="G28 reference return")

    def _machine_move(self, block, st, letters, motion_code):
        if motion_code not in (None, "G0", "G1"):
            self.diag("error", "G53_MOTION", "G53 is only valid with G00/G01. Verification stopped.", block, halt=True)
        self.diag(
            "warning",
            "MACHINE_COORDS_ASSUMED",
            "G53 moves are in machine coordinates. They are only placed correctly if the work offsets in "
            "Job Setup are the real machine values; with zero offsets, machine zero is drawn at part zero.",
            block,
            once_key="g53",
        )
        target = list(st.pos)
        for i, a in enumerate(AXES):
            if a in letters:
                target[i] = self.value(st, letters[a], block)
        self._rapid(block, st, target, op="reference", note="G53 machine move")

    # ------------------------------------------------------------- cycles
    def _update_cycle_params(self, block, st, letters):
        if "R" in letters:
            st.cycle_r = self.value(st, letters["R"], block)
        if "Z" in letters:
            st.cycle_z = self.value(st, letters["Z"], block)
        if "Q" in letters:
            st.cycle_q = abs(self.value(st, letters["Q"], block))
        if "P" in letters:
            st.cycle_p = letters["P"].value / 1000.0

    def _cycle(self, block, st, letters):
        code = st.cycle
        op = CYCLE_OPS.get(code, "drill")
        self._check_startup(block)
        if st.cycle_z is None or st.cycle_r is None:
            self.diag(
                "error",
                "CYCLE_PARAMS",
                f"{code} without Z depth or R level. Verification stopped.",
                block,
                halt=True,
            )
        if code in ("G73", "G83") and not st.cycle_q:
            self.diag("error", "CYCLE_NO_Q", f"{code} peck drilling without Q (peck depth). Verification stopped.", block, halt=True)
        feed = self._feed_rate(block, st)
        if st.spindle_dir == 0 or st.spindle_speed <= 0:
            self.diag("error", "SPINDLE_OFF_CUT", f"{code} with the spindle stopped.", block)
        if code == "G84" and st.spindle_dir < 0:
            self.diag("error", "TAP_DIRECTION", "G84 right-hand tapping with spindle CCW (M04).", block)
        if code == "G74" and st.spindle_dir > 0:
            self.diag("error", "TAP_DIRECTION", "G74 left-hand tapping with spindle CW (M03).", block)
        if st.tool is None:
            self.diag("warning", "NO_TOOL", "Drilling starts without a T/M06 tool change.", block, once_key="no_tool")

        repeats = 1
        if "K" in letters:
            repeats = int(letters["K"].value)
        elif "L" in letters:
            repeats = int(letters["L"].value)
        if repeats <= 0:
            return  # K0: store data only

        initial_z = st.cycle_initial_z if st.cycle_initial_z is not None else self.to_work(st, st.pos)[2]
        for _ in range(repeats):
            work = self.to_work(st, st.pos)
            if st.distance == "G91":
                r_level = initial_z + st.cycle_r
                bottom = r_level + st.cycle_z
                for i, a in enumerate(("X", "Y")):
                    if a in letters:
                        work[i] += self.value(st, letters[a], block)
            else:
                r_level = st.cycle_r
                bottom = st.cycle_z
                for i, a in enumerate(("X", "Y")):
                    if a in letters:
                        work[i] = self.value(st, letters[a], block)
            if bottom > r_level:
                self.diag(
                    "error",
                    "CYCLE_DEPTH",
                    f"{code}: hole bottom Z{bottom:.3f} is above the R level {r_level:.3f}. Verification stopped.",
                    block,
                    halt=True,
                )
            if r_level > initial_z + 1e-9 and st.cycle_return == "G98":
                self.diag("warning", "CYCLE_R_ABOVE_INITIAL", f"{code}: R level is above the initial level.", block)
            # 1. position in XY at current height
            xy = self.to_machine(st, [work[0], work[1], work[2]])
            self._rapid(block, st, xy, op="position")
            # 2. rapid to R level
            r_pt = self.to_machine(st, [work[0], work[1], r_level])
            self._rapid(block, st, r_pt, op=op)
            # 3. cycle body
            self._cycle_body(block, st, code, op, work, r_level, bottom, feed)
            # 4. return
            ret_z = initial_z if st.cycle_return == "G98" else r_level
            ret_pt = self.to_machine(st, [work[0], work[1], ret_z])
            self._rapid(block, st, ret_pt, op=op)

    def _feed_to(self, block, st, target, feed, op, note=None):
        start = list(st.pos)
        length = math.dist(start, target)
        if length < 1e-9:
            return
        self._emit("feed", op, block, start, target, length / feed * 60.0, length, st, feed=feed, note=note)
        st.pos = list(target)

    def _cycle_body(self, block, st, code, op, work, r_level, bottom, feed):
        at = lambda z: self.to_machine(st, [work[0], work[1], z])  # noqa: E731
        if code in ("G81", "G82"):
            self._feed_to(block, st, at(bottom), feed, op)
            if code == "G82" and st.cycle_p:
                self._emit("dwell", op, block, st.pos, st.pos, st.cycle_p, 0.0, st, note=f"Dwell {st.cycle_p:g} s")
        elif code in ("G73", "G83"):
            q = st.cycle_q
            d = self.dialect.peck_clearance_mm
            depth = r_level
            while depth > bottom + 1e-9:
                nxt = max(depth - q, bottom)
                if code == "G83" and depth < r_level - 1e-9:
                    self._rapid(block, st, at(depth + d), op=op)
                self._feed_to(block, st, at(nxt), feed, op, note="peck")
                depth = nxt
                if depth > bottom + 1e-9:
                    if code == "G83":
                        self._rapid(block, st, at(r_level), op=op)
                    else:
                        self._rapid(block, st, at(depth + d), op=op)
        elif code in ("G84", "G74"):
            self._feed_to(block, st, at(bottom), feed, op, note="tap in")
            if st.cycle_p:
                self._emit("dwell", op, block, st.pos, st.pos, st.cycle_p, 0.0, st)
            self._feed_to(block, st, at(r_level), feed, op, note="tap out (spindle reversed)")
        elif code in ("G85", "G89"):
            self._feed_to(block, st, at(bottom), feed, op)
            if code == "G89" and st.cycle_p:
                self._emit("dwell", op, block, st.pos, st.pos, st.cycle_p, 0.0, st)
            self._feed_to(block, st, at(r_level), feed, op, note="feed out")
        elif code in ("G86", "G76", "G88"):
            self._feed_to(block, st, at(bottom), feed, op)
            if code == "G88" and st.cycle_p:
                self._emit("dwell", op, block, st.pos, st.pos, st.cycle_p, 0.0, st)
        else:  # pragma: no cover - guarded by dialect table
            self.diag("error", "UNSUPPORTED_CODE", f"{code} not implemented.", block, halt=True)

    # ------------------------------------------------------------- summary
    def _finish(self, st):
        if self._no_decimal:
            lines = sorted(set(self._no_decimal))
            sample = ", ".join(str(n) for n in lines[:8]) + (" ..." if len(lines) > 8 else "")
            if self.settings.decimal_mode == "calculator":
                msg = (
                    f"{len(lines)} line(s) have coordinates without a decimal point (lines {sample}). "
                    "They were read as whole millimetres/inches (e.g. X10 = 10 mm). On a FANUC with "
                    "parameter 3401#0 (DPI) = 0, X10 means 0.010 mm. Confirm the machine setting."
                )
            else:
                msg = (
                    f"{len(lines)} line(s) have coordinates without a decimal point (lines {sample}). "
                    "They were read in least input increments (X10 = 0.010 mm)."
                )
            self.diags.append(Diagnostic("warning", "NO_DECIMAL_POINT", msg, lines[0], None))
        if not st.ended and self.halted_at is None:
            self.diags.append(Diagnostic("warning", "NO_PROGRAM_END", "Program has no M02/M30 end.", None, None))

    def _summary(self, blocks, st) -> dict:
        rapid_dist = sum(m.length for m in self.moves if m.kind == "rapid")
        cut_dist = sum(m.length for m in self.moves if m.kind in ("feed", "arc"))
        t_rapid = sum(m.duration for m in self.moves if m.kind == "rapid")
        t_cut = sum(m.duration for m in self.moves if m.kind in ("feed", "arc"))
        t_dwell = sum(m.duration for m in self.moves if m.kind == "dwell")
        t_tc = sum(m.duration for m in self.moves if m.kind == "toolchange")
        tool_changes = sum(1 for m in self.moves if m.kind == "toolchange")

        tools: dict[int | None, dict] = defaultdict(lambda: {"cut_length": 0.0, "cut_time": 0.0, "first_line": None, "ops": set()})
        for m in self.moves:
            t = tools[m.tool]
            if t["first_line"] is None:
                t["first_line"] = m.line
            if m.kind in ("feed", "arc"):
                t["cut_length"] += m.length
                t["cut_time"] += m.duration
                t["ops"].add(m.op)
        tool_rows = [
            {
                "tool": k,
                "first_line": v["first_line"],
                "cut_length": round(v["cut_length"], 2),
                "cut_time": round(v["cut_time"], 2),
                "operations": sorted(v["ops"]),
            }
            for k, v in tools.items()
            if k is not None or v["cut_length"] > 0
        ]

        holes = Counter()
        seen_holes = set()
        for m in self.moves:
            if m.op in ("drill", "tap", "bore") and m.kind == "feed":
                key = (m.block, round(m.end[0], 4), round(m.end[1], 4))
                if key not in seen_holes:
                    seen_holes.add(key)
                    holes[m.op] += 1

        def bounds(moves):
            pts = []
            for m in moves:
                pts.extend(m.points or [m.start, m.end])
            if not pts:
                return None
            return {
                "min": [round(min(p[i] for p in pts), 4) for i in range(3)],
                "max": [round(max(p[i] for p in pts), 4) for i in range(3)],
            }

        severities = Counter(d.severity for d in self.diags)
        if self.halted_at is not None:
            status = "halted"
        elif severities["error"]:
            status = "errors"
        elif severities["warning"]:
            status = "warnings"
        else:
            status = "ok"

        limitations = [
            "Material removal is not simulated yet (Phase 2).",
            "Tool, holder, vice and fixture geometry are not modelled yet (Phase 3).",
            "Machine travel limits and collisions are not checked yet (Phase 4).",
        ]
        if any(d.code == "CUTTER_COMP" for d in self.diags):
            limitations.append("Cutter radius compensation (G41/G42) is shown as the programmed path, not the offset cutter centre.")
        if self.settings.rapid_mode == "linear":
            limitations.append("Rapid moves are drawn as straight lines; set rapid mode to dog-leg if the machine uses non-interpolated rapids.")

        return {
            "status": status,
            "halted_at_block": self.halted_at,
            "halted_at_line": blocks[self.halted_at].line if self.halted_at is not None else None,
            "verification_complete": False,
            "limitations": limitations,
            "blocks_total": len(blocks),
            "blocks_executed": self.executed_blocks,
            "move_count": len(self.moves),
            "rapid_count": sum(1 for m in self.moves if m.kind == "rapid"),
            "linear_count": sum(1 for m in self.moves if m.kind == "feed" and m.op == "mill"),
            "arc_count": sum(1 for m in self.moves if m.kind == "arc"),
            "rapid_distance": round(rapid_dist, 2),
            "cutting_distance": round(cut_dist, 2),
            "time_rapid": round(t_rapid, 2),
            "time_cutting": round(t_cut, 2),
            "time_dwell": round(t_dwell, 2),
            "time_toolchange": round(t_tc, 2),
            "time_total": round(t_rapid + t_cut + t_dwell + t_tc, 2),
            "tool_changes": tool_changes,
            "tools": tool_rows,
            "holes": dict(holes),
            "bounds_all": bounds(self.moves),
            "bounds_cutting": bounds([m for m in self.moves if m.kind in ("feed", "arc")]),
            "errors": severities["error"],
            "warnings": severities["warning"],
            "infos": severities["info"],
            "final_units": st.units,
        }


def interpret(text: str, settings: InterpreterSettings | None = None) -> InterpretResult:
    return Interpreter(settings).run(text)
