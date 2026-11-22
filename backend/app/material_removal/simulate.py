"""Run the interpreter's motion list through the Z-map stock model."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from ..gcode.model import Diagnostic
from .tools import ToolSpec
from .zmap import Grid, ZMap

MAX_PER_CODE = 25


@dataclass
class StockSetup:
    size: tuple[float, float, float] = (200.0, 150.0, 40.0)
    origin: str = "top-center"
    top_z: float = 0.0
    allowance: float = 0.0
    material: str = ""


def stock_box(s: StockSetup):
    sx, sy, sz = s.size
    a = s.allowance
    x0, y0 = {
        "top-front-left": (0.0, 0.0),
        "top-front-right": (-sx, 0.0),
        "top-back-left": (0.0, -sy),
        "top-back-right": (-sx, -sy),
    }.get(s.origin, (-sx / 2, -sy / 2))
    return (x0 - a, y0 - a, s.top_z - sz), (x0 + sx + a, y0 + sy + a, s.top_z + a)


@dataclass
class StockResult:
    grid: Grid
    zmap: ZMap
    diagnostics: list[Diagnostic] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def simulate(moves: list[dict], stock: StockSetup, tools: dict[int | None, ToolSpec]) -> StockResult:
    lo, hi = stock_box(stock)
    grid = Grid.for_box(lo, hi)
    zm = ZMap(grid)
    initial = zm.stock_volume
    diags: list[Diagnostic] = []
    counts: Counter = Counter()
    flagged: set[tuple[str, int]] = set()

    def flag(severity, code, message, m):
        key = (code, m["block"])
        if key in flagged:
            return
        flagged.add(key)
        counts[code] += 1
        if counts[code] <= MAX_PER_CODE:
            diags.append(Diagnostic(severity, code, message, m["line"], m["block"]))

    removed_by_tool: dict = defaultdict(float)
    time_in_material = 0.0
    time_air = 0.0
    rapid_hits = 0
    default_tool = ToolSpec(None).normalised()

    for m in moves:
        if m["kind"] not in ("rapid", "feed", "arc"):
            continue
        tool = tools.get(m["tool"], default_tool)
        pts = m.get("points") or [m["start"], m["end"]]
        tool_id = m["tool"] if m["tool"] is not None else 0
        r = zm.apply_polyline(pts, tool, tool_id)
        if r.cells_cut:
            removed_by_tool[m["tool"]] += r.removed_volume
        if m["kind"] == "rapid":
            if r.cells_cut:
                rapid_hits += 1
                flag(
                    "error",
                    "RAPID_IN_STOCK",
                    f"Rapid move (G00) cuts material: about {r.removed_volume:.1f} mm³ removed by T{m['tool']} at rapid traverse. "
                    "On the machine this is a crash risk.",
                    m,
                )
        else:
            if r.cells_cut:
                time_in_material += m["duration"]
                if not m["spindle"]:
                    flag("error", "SPINDLE_OFF_IN_STOCK", "The tool cuts material with the spindle stopped.", m)
            else:
                time_air += m["duration"]
        if r.below_bottom:
            flag(
                "warning",
                "BELOW_STOCK_BOTTOM",
                f"Tool tip goes below the stock bottom (Z{grid.bottom:.3f}) over the stock. It would cut into the table, "
                "parallels or vice unless the part is raised.",
                m,
            )

    for code, n in counts.items():
        if n > MAX_PER_CODE:
            diags.append(Diagnostic("info", code, f"{n - MAX_PER_CODE} more '{code}' findings not listed.", None, None))

    final = zm.stock_volume
    cut_total = time_in_material + time_air
    stats = {
        "grid": grid.to_dict(),
        "material": stock.material,
        "initial_volume": round(initial, 1),
        "final_volume": round(final, 1),
        "removed_volume": round(initial - final, 1),
        "removed_by_tool": [{"tool": k, "volume": round(v, 1)} for k, v in sorted(removed_by_tool.items(), key=lambda kv: (kv[0] is None, kv[0] or 0))],
        "time_in_material": round(time_in_material, 2),
        "time_air_cutting": round(time_air, 2),
        "air_cutting_percent": round(100.0 * time_air / cut_total, 1) if cut_total else 0.0,
        "rapid_in_stock_moves": rapid_hits,
        "lowest_point": round(float(zm.height.min()), 4),
    }
    return StockResult(grid, zm, diags, stats)
