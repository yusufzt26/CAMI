"""Runs the verification engines in order and merges their findings.

interpreter (G-code -> motions) -> material removal (motions -> stock)
-> [collision, Phase 4] -> [analysis/report, Phase 5]
"""

from __future__ import annotations

from collections import Counter

from .gcode import InterpreterSettings, interpret
from .gcode.lexer import tokenize
from .gcode.model import Diagnostic
from .material_removal import StockSetup, resolve_tools, simulate, tool_hints_from_comments


def verify(text: str, settings: InterpreterSettings, stock: StockSetup, tool_overrides: dict[str, dict], start=None) -> dict:
    """start: ZMap left by the previous program of a set (result["_zmap"] of that run), or None."""
    blocks = tokenize(text)
    hints = tool_hints_from_comments(blocks)
    # Cutter compensation needs tool radii before interpretation: D<n> is taken as the radius of T<n>.
    declared = {int(w.value) for b in blocks for w in b.words if w.letter == "T"}
    declared |= {int(k) for k in tool_overrides if k.isdigit()}
    settings.comp_radii = {n: spec.radius for n, spec in resolve_tools(sorted(declared), hints, tool_overrides).items() if n is not None}

    result = interpret(text, settings)
    used = sorted({m["tool"] for m in result.moves}, key=lambda t: (t is None, t or 0))
    tools = resolve_tools(used, hints, tool_overrides)

    extra: list[Diagnostic] = []
    cutting_tools = {m["tool"] for m in result.moves if m["kind"] in ("feed", "arc")}
    for n, spec in tools.items():
        if spec.source == "default" and n is not None and n in cutting_tools:
            label = f"T{n}"
            extra.append(
                Diagnostic(
                    "warning",
                    "TOOL_ASSUMED",
                    f"{label} has no size in the program comments: assumed Ø{spec.diameter:g} flat end mill. "
                    "Set the real tool in the tool table, or the cut material shown will be wrong.",
                )
            )

    stock_result = simulate(result.moves, stock, tools, start)
    diagnostics = result.diagnostics + [d.to_dict() for d in extra + stock_result.diagnostics]

    summary = dict(result.summary)
    sev = Counter(d["severity"] for d in diagnostics)
    summary["errors"], summary["warnings"], summary["infos"] = sev["error"], sev["warning"], sev["info"]
    if summary["status"] != "halted":
        summary["status"] = "errors" if sev["error"] else "warnings" if sev["warning"] else "ok"
    cell = stock_result.grid.cell
    summary["limitations"] = [
        lim for lim in summary["limitations"] if not lim.startswith("Material removal")
    ] + [f"Material removal uses a {cell:.2f} mm height grid: details smaller than this are approximated, and undercuts are not modelled."]
    if start is not None:
        summary["limitations"].append("Stock starts from what the earlier programs of the set left (same stock grid).")
    if any(d.code == "TOOL_ASSUMED" for d in extra):
        summary["limitations"].append("Some tool sizes were assumed, so the simulated stock may differ from the real part.")
    summary["stock"] = stock_result.stats

    return {
        "blocks": result.blocks,
        "moves": result.moves,
        "diagnostics": diagnostics,
        "summary": summary,
        "settings": result.settings,
        "tools": [
            {**spec.to_dict(), "key": "none" if n is None else str(n)} for n, spec in tools.items()
        ],
        "stock": stock_result.stats,
        "_zmap": stock_result.zmap,  # not serialised by the API; start stock for the next program of a set
    }
