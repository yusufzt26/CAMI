"""Cutter shapes for stock removal, and tool hints read from program comments.

A tool is modelled by its radial profile h(r): the height of the cutting surface
above the tool tip at radial distance r from the axis. The tool tip is the
programmed point (G43 tool-length compensation is assumed correct).
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass

import numpy as np

TOOL_TYPES = (
    "flat",  # flat end mill
    "ball",  # ball nose
    "bull",  # bull nose / corner radius
    "face",  # face mill
    "drill",
    "spot",  # spot / centre drill
    "reamer",
    "tap",
    "counterbore",
)

DEFAULT_POINT_ANGLE = {"drill": 118.0, "spot": 90.0}


@dataclass
class ToolSpec:
    number: int | None
    type: str = "flat"
    diameter: float = 10.0
    corner_radius: float = 0.0
    point_angle: float = 118.0
    source: str = "default"  # default | comment | user
    description: str = ""

    @property
    def radius(self) -> float:
        return self.diameter / 2.0

    def normalised(self) -> "ToolSpec":
        t = self.type if self.type in TOOL_TYPES else "flat"
        d = max(float(self.diameter), 0.01)
        cr = float(self.corner_radius)
        if t == "ball":
            cr = d / 2
        elif t == "bull":
            cr = min(max(cr, 0.0), d / 2)
        else:
            cr = 0.0
        angle = self.point_angle if t in DEFAULT_POINT_ANGLE else 180.0
        if t in DEFAULT_POINT_ANGLE and not (10.0 < angle < 180.0):
            angle = DEFAULT_POINT_ANGLE[t]
        return ToolSpec(self.number, t, d, cr, angle, self.source, self.description)

    def profile(self, r: np.ndarray) -> np.ndarray:
        """Height of the cutting surface above the tip at radial distance r (r <= radius)."""
        R = self.radius
        if self.type == "ball":
            return R - np.sqrt(np.maximum(R * R - r * r, 0.0))
        if self.type == "bull" and self.corner_radius > 0:
            rc = self.corner_radius
            flat = R - rc
            out = np.zeros_like(r)
            m = r > flat
            out[m] = rc - np.sqrt(np.maximum(rc * rc - (r[m] - flat) ** 2, 0.0))
            return out
        if self.type in ("drill", "spot"):
            return r / math.tan(math.radians(self.point_angle) / 2)
        return np.zeros_like(r)

    @property
    def is_flat_bottom(self) -> bool:
        return self.type not in ("ball", "bull", "drill", "spot") or (self.type == "bull" and self.corner_radius == 0)

    def to_dict(self) -> dict:
        return asdict(self)


# ------------------------------------------------------------------ hints
_T_RE = re.compile(r"\bT\s*(\d{1,3})\b")
_D_RE = re.compile(r"(?:\bD(?:IA)?\s*=?\s*|Ø\s*|\bDIA\.?\s*)(\d+(?:\.\d+)?)")
_MM_RE = re.compile(r"\b(\d+(?:\.\d+)?)\s*MM\b")
_CR_RE = re.compile(r"\b(?:CR|RC|R)\s*=?\s*(\d+(?:\.\d+)?)\b")
_THREAD_RE = re.compile(r"\bM(\d+(?:\.\d+)?)(?:\s*X|\b)")
_ANGLE_RE = re.compile(r"(\d{2,3})\s*(?:DEG|°)")

_KEYWORDS = [
    ("ball", ("BALL",)),
    ("bull", ("BULL", "TORUS", "TOROID", "CORNER R")),
    ("face", ("FACE",)),
    ("spot", ("SPOT", "CENTRE DRILL", "CENTER DRILL", "C/DRILL")),
    ("tap", ("TAP",)),
    ("reamer", ("REAM",)),
    ("counterbore", ("C'BORE", "CBORE", "COUNTERBORE", "C-BORE")),
    ("drill", ("DRILL",)),
    ("flat", ("END MILL", "ENDMILL", "FLAT", "SLOT", "E/M", "SHOULDER")),
]


def _parse_description(text: str) -> dict | None:
    u = text.upper()
    kind = None
    for k, words in _KEYWORDS:
        if any(re.search(r"(?<![A-Z])" + re.escape(w) + r"(?![A-Z])", u) for w in words):
            kind = k
            break
    dia = None
    m = _D_RE.search(u)
    if m:
        dia = float(m.group(1))
    elif kind == "tap" and (mt := _THREAD_RE.search(u)):
        dia = float(mt.group(1))
    elif (mm := _MM_RE.search(u)):
        dia = float(mm.group(1))
    if dia is None and kind is None:
        return None
    cr = None
    mcr = _CR_RE.search(u)
    if mcr:
        cr = float(mcr.group(1))
    out: dict = {"description": text.strip()}
    if kind:
        out["type"] = kind
    if dia is not None and dia > 0:
        out["diameter"] = dia
    if cr is not None:
        out["corner_radius"] = cr
        if kind in (None, "flat") and cr > 0:
            out["type"] = "bull"
    if (ma := _ANGLE_RE.search(u)) and kind in ("drill", "spot"):
        out["point_angle"] = float(ma.group(1))
    return out


def tool_hints_from_comments(blocks) -> dict[int, dict]:
    """Read tool descriptions that CAM posts write as comments.

    Handles "(T2 D16 FLAT END MILL)", "(T1 D=10. CR=0. - FLAT END MILL)",
    lists separated by '/', and comments on the tool-change line
    ("T4 M06 (M12 X 1.75 TAP)").
    """
    hints: dict[int, dict] = {}
    for b in blocks:
        if not b.comment:
            continue
        parts = re.split(r"\s/\s|;", b.comment)
        own_t = None
        tw = b.get("T") if hasattr(b, "get") else None
        if tw is not None:
            own_t = int(tw.value)
        for part in parts:
            m = _T_RE.search(part.upper())
            number = int(m.group(1)) if m else own_t
            if number is None:
                continue
            body = part[m.end() :] if m else part
            info = _parse_description(body)
            if info and number not in hints:
                hints[number] = info
    return hints


def resolve_tools(tool_numbers, hints: dict[int, dict], overrides: dict[str, dict]) -> dict[int | None, ToolSpec]:
    tools: dict[int | None, ToolSpec] = {}
    for n in tool_numbers:
        key = "none" if n is None else str(n)
        if key in overrides and overrides[key]:
            o = overrides[key]
            spec = ToolSpec(n, o.get("type", "flat"), o.get("diameter", 10.0), o.get("corner_radius", 0.0), o.get("point_angle", DEFAULT_POINT_ANGLE.get(o.get("type", ""), 118.0)), "user", o.get("description", ""))
        elif n is not None and n in hints:
            h = hints[n]
            t = h.get("type", "flat")
            spec = ToolSpec(
                n,
                t,
                h.get("diameter", 10.0),
                h.get("corner_radius", 0.0),
                h.get("point_angle", DEFAULT_POINT_ANGLE.get(t, 118.0)),
                "comment" if "diameter" in h else "default",
                h.get("description", ""),
            )
        else:
            spec = ToolSpec(n)
        tools[n] = spec.normalised()
    return tools
