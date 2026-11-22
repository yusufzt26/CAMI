"""Data model shared by the interpreter and the API."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

Severity = Literal["error", "warning", "info"]
MoveKind = Literal["rapid", "feed", "arc", "dwell", "toolchange", "stop"]
OpKind = Literal["position", "mill", "drill", "tap", "bore", "reference", "none"]

WCS_CODES = ("G54", "G55", "G56", "G57", "G58", "G59")


@dataclass
class InterpreterSettings:
    controller: str = "fanuc"
    initial_units: Literal["mm", "inch"] = "mm"
    # Machine coordinates of each work coordinate origin (mm).
    work_offsets: dict[str, list[float]] = field(default_factory=lambda: {c: [0.0, 0.0, 0.0] for c in WCS_CODES})
    # Machine coordinates of the reference (home) position used by G28 (mm).
    reference_position: list[float] = field(default_factory=lambda: [0.0, 0.0, 100.0])
    rapid_rate: float = 15000.0  # mm/min
    max_feed: float = 10000.0  # mm/min
    tool_change_time: float = 6.0  # s
    # "calculator": X10 = 10 mm. "least_increment": X10 = 0.010 mm (FANUC parameter 3401#0 = 0).
    decimal_mode: Literal["calculator", "least_increment"] = "calculator"
    # FANUC rapids are non-interpolated ("dog-leg") unless parameter 1401#1 is set.
    rapid_mode: Literal["linear", "dogleg"] = "linear"
    block_delete_switch: bool = False  # True = blocks starting with '/' are skipped
    # G41/G42: "tool_radius" = D register holds the radius of the tool with the same number;
    # "zero" = D holds wear only (CAM already output the cutter-centre path).
    cutter_comp_mode: Literal["tool_radius", "zero"] = "tool_radius"
    comp_radii: dict[int, float] = field(default_factory=dict)  # D number -> radius (mm)
    arc_radius_tolerance: float = 0.02  # mm; start/end radius mismatch that raises an alarm
    chord_tolerance: float = 0.005  # mm; arc tessellation accuracy


@dataclass
class Diagnostic:
    severity: Severity
    code: str
    message: str
    line: int | None = None
    block: int | None = None
    halt: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Move:
    kind: MoveKind
    op: OpKind
    block: int
    line: int
    start: list[float]
    end: list[float]
    duration: float  # seconds
    length: float = 0.0  # mm
    feed: float | None = None  # mm/min (effective)
    tool: int | None = None
    spindle: float = 0.0  # signed rpm, + = CW
    coolant: bool = False
    points: list[list[float]] | None = None  # polyline incl. start and end, for arcs/dog-legs
    note: str | None = None

    def to_dict(self) -> dict:
        d = {
            "kind": self.kind,
            "op": self.op,
            "block": self.block,
            "line": self.line,
            "start": [round(v, 5) for v in self.start],
            "end": [round(v, 5) for v in self.end],
            "duration": round(self.duration, 5),
            "length": round(self.length, 5),
            "feed": self.feed,
            "tool": self.tool,
            "spindle": self.spindle,
            "coolant": self.coolant,
        }
        if self.points is not None:
            d["points"] = [[round(v, 5) for v in p] for p in self.points]
        if self.note:
            d["note"] = self.note
        return d
