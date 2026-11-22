"""Z-map (height-field) stock model for 3-axis milling and drilling.

The stock is a regular XY grid; each cell stores the current top Z of material.
A vertical tool sweeping along a straight segment lowers every cell it covers to
the lowest point of the tool surface over that cell. This is the standard
representation for 3-axis verification: it is exact for everything a vertical
spindle can produce (no undercuts), and min() updates are order independent,
so partial and complete moves can be applied in any order.

The frontend runs the same algorithm (frontend/src/sim/zmap.ts) for live
playback; this module is the authority for checks and analysis.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .tools import ToolSpec

MAX_CELLS = 160_000
MIN_CELL = 0.2  # mm
CUT_TOLERANCE = 0.01  # mm; material thinner than this is ignored
RAMP_SAMPLES = 12


@dataclass(frozen=True)
class Grid:
    x0: float
    y0: float
    nx: int
    ny: int
    cx: float  # cell size in X
    cy: float  # cell size in Y
    top: float
    bottom: float

    @staticmethod
    def for_box(min_xyz, max_xyz, max_cells: int = MAX_CELLS) -> "Grid":
        sx = max_xyz[0] - min_xyz[0]
        sy = max_xyz[1] - min_xyz[1]
        cell = max(MIN_CELL, math.sqrt(sx * sy / max_cells))
        nx = max(2, int(round(sx / cell)))
        ny = max(2, int(round(sy / cell)))
        # Cells are stretched slightly so the grid spans the stock exactly.
        return Grid(min_xyz[0], min_xyz[1], nx, ny, sx / nx, sy / ny, max_xyz[2], min_xyz[2])

    @property
    def cell(self) -> float:
        return max(self.cx, self.cy)

    def to_dict(self) -> dict:
        return {
            "x0": self.x0,
            "y0": self.y0,
            "nx": self.nx,
            "ny": self.ny,
            "cx": self.cx,
            "cy": self.cy,
            "top": self.top,
            "bottom": self.bottom,
        }


@dataclass
class SegmentResult:
    removed_volume: float
    cells_cut: int
    below_bottom: bool


class ZMap:
    def __init__(self, grid: Grid):
        self.grid = grid
        self.height = np.full((grid.ny, grid.nx), grid.top, dtype=np.float64)
        self.cut_by = np.full((grid.ny, grid.nx), -1, dtype=np.int32)  # tool number that last cut the cell
        xs = grid.x0 + (np.arange(grid.nx) + 0.5) * grid.cx
        ys = grid.y0 + (np.arange(grid.ny) + 0.5) * grid.cy
        self._xs = xs
        self._ys = ys

    @property
    def stock_volume(self) -> float:
        g = self.grid
        return float(np.sum(self.height - g.bottom) * g.cx * g.cy)

    def _window(self, xmin, xmax, ymin, ymax):
        g = self.grid
        i0 = max(0, int(math.floor((xmin - g.x0) / g.cx - 0.5)))
        i1 = min(g.nx, int(math.ceil((xmax - g.x0) / g.cx + 0.5)))
        j0 = max(0, int(math.floor((ymin - g.y0) / g.cy - 0.5)))
        j1 = min(g.ny, int(math.ceil((ymax - g.y0) / g.cy + 0.5)))
        return i0, i1, j0, j1

    def apply_segment(self, p0, p1, tool: ToolSpec, tool_id: int = 0) -> SegmentResult:
        g = self.grid
        R = tool.radius
        x0, y0, z0 = p0
        x1, y1, z1 = p1
        lowest = min(z0, z1)
        # Quick reject: tool entirely above the current stock top or outside the grid.
        if lowest >= g.top - CUT_TOLERANCE:
            return SegmentResult(0.0, 0, False)
        i0, i1, j0, j1 = self._window(min(x0, x1) - R, max(x0, x1) + R, min(y0, y1) - R, max(y0, y1) + R)
        if i0 >= i1 or j0 >= j1:
            return SegmentResult(0.0, 0, False)
        X = self._xs[i0:i1][None, :]
        Y = self._ys[j0:j1][:, None]
        dx, dy, dz = x1 - x0, y1 - y0, z1 - z0
        L2 = dx * dx + dy * dy
        if L2 < 1e-12:
            r = np.sqrt((X - x0) ** 2 + (Y - y0) ** 2)
            mask = r <= R
            zc = lowest + tool.profile(np.minimum(r, R))
        else:
            L = math.sqrt(L2)
            t0 = ((X - x0) * dx + (Y - y0) * dy) / L2
            px = X - (x0 + t0 * dx)
            py = Y - (y0 + t0 * dy)
            d2 = px * px + py * py
            half = np.sqrt(np.maximum(R * R - d2, 0.0)) / L
            lo = np.maximum(t0 - half, 0.0)
            hi = np.minimum(t0 + half, 1.0)
            mask = (d2 <= R * R) & (lo <= hi)
            if tool.is_flat_bottom:
                # z is linear in t, so the lowest flat-bottom position is at an interval end.
                zc = z0 + (lo if dz >= 0 else hi) * dz
            elif abs(dz) < 1e-12:
                tc = np.clip(t0, 0.0, 1.0)
                r = np.sqrt((X - (x0 + tc * dx)) ** 2 + (Y - (y0 + tc * dy)) ** 2)
                mask = r <= R
                zc = z0 + tool.profile(np.minimum(r, R))
            else:
                zc = np.full(np.broadcast(X, Y).shape, np.inf)
                for k in range(RAMP_SAMPLES):
                    ts = lo + (hi - lo) * (k / (RAMP_SAMPLES - 1))
                    rr = np.sqrt(d2 + (L * (ts - t0)) ** 2)
                    zc = np.minimum(zc, z0 + ts * dz + tool.profile(np.minimum(rr, R)))
        if not np.any(mask):
            return SegmentResult(0.0, 0, False)
        below = bool(lowest < g.bottom - CUT_TOLERANCE)
        new = np.maximum(zc, g.bottom)
        cur = self.height[j0:j1, i0:i1]
        cut = mask & (new < cur - CUT_TOLERANCE)
        if not np.any(cut):
            return SegmentResult(0.0, 0, below)
        removed = float(np.sum((cur - new)[cut]) * g.cx * g.cy)
        cur[cut] = new[cut]
        self.cut_by[j0:j1, i0:i1][cut] = tool_id
        return SegmentResult(removed, int(np.count_nonzero(cut)), below)

    def apply_polyline(self, points, tool: ToolSpec, tool_id: int = 0) -> SegmentResult:
        total = SegmentResult(0.0, 0, False)
        for a, b in zip(points[:-1], points[1:]):
            r = self.apply_segment(a, b, tool, tool_id)
            total.removed_volume += r.removed_volume
            total.cells_cut += r.cells_cut
            total.below_bottom = total.below_bottom or r.below_bottom
        return total
