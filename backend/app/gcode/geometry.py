"""Geometry helpers for the interpreter: arcs and rapid paths."""

from __future__ import annotations

import math
from dataclasses import dataclass

# Plane -> (first axis index, second axis index, normal axis index)
PLANE_AXES = {"G17": (0, 1, 2), "G18": (2, 0, 1), "G19": (1, 2, 0)}


class ArcError(ValueError):
    pass


@dataclass
class ArcResult:
    center: list[float]
    radius: float
    sweep: float  # signed radians, negative = CW
    points: list[list[float]]
    length: float
    radius_error: float  # |r_end - r_start| for IJK arcs


def arc_center_from_offsets(start, offsets, plane):
    a, b, _ = PLANE_AXES[plane]
    center = list(start)
    center[a] = start[a] + offsets[0]
    center[b] = start[b] + offsets[1]
    return center


def arc_center_from_radius(start, end, r, clockwise, plane, tol=1e-3):
    a, b, _ = PLANE_AXES[plane]
    dx, dy = end[a] - start[a], end[b] - start[b]
    d = math.hypot(dx, dy)
    if d < 1e-9:
        raise ArcError("R-format arc with identical start and end point (full circle needs I/J/K)")
    half = d / 2.0
    if half > abs(r) + tol:
        raise ArcError(f"Arc radius R{abs(r):g} too small for chord length {d:.4f} mm")
    h = math.sqrt(max(r * r - half * half, 0.0))
    mx, my = start[a] + dx / 2, start[b] + dy / 2
    # Unit perpendicular to the chord (rotated +90 deg).
    px, py = -dy / d, dx / d
    # For a CCW arc <= 180 deg the centre lies to the left of the chord.
    sign = 1.0 if not clockwise else -1.0
    if r < 0:  # R negative selects the arc > 180 deg
        sign = -sign
    center = list(start)
    center[a] = mx + sign * h * px
    center[b] = my + sign * h * py
    return center


def build_arc(start, end, center, clockwise, plane, chord_tol, full_circle_allowed=True) -> ArcResult:
    a, b, n = PLANE_AXES[plane]
    r0 = math.hypot(start[a] - center[a], start[b] - center[b])
    r1 = math.hypot(end[a] - center[a], end[b] - center[b])
    if r0 < 1e-9:
        raise ArcError("Arc centre coincides with start point")
    th0 = math.atan2(start[b] - center[b], start[a] - center[a])
    th1 = math.atan2(end[b] - center[b], end[a] - center[a])
    same_point = math.hypot(end[a] - start[a], end[b] - start[b]) < 1e-6
    if clockwise:
        sweep = th1 - th0
        if sweep >= -1e-12:
            sweep -= 2 * math.pi
        if same_point:
            sweep = -2 * math.pi
    else:
        sweep = th1 - th0
        if sweep <= 1e-12:
            sweep += 2 * math.pi
        if same_point:
            sweep = 2 * math.pi
    if same_point and not full_circle_allowed:
        raise ArcError("Full circle not allowed")

    r = r0
    if r <= chord_tol:
        seg = 4
    else:
        step = 2 * math.acos(max(-1.0, min(1.0, 1 - chord_tol / r)))
        seg = int(math.ceil(abs(sweep) / max(step, 1e-6)))
    seg = max(4, min(seg, 720))

    dn = end[n] - start[n]
    points = []
    for i in range(seg + 1):
        t = i / seg
        th = th0 + sweep * t
        rr = r0 + (r1 - r0) * t  # spiral blend if radii mismatch slightly
        p = [0.0, 0.0, 0.0]
        p[a] = center[a] + rr * math.cos(th)
        p[b] = center[b] + rr * math.sin(th)
        p[n] = start[n] + dn * t
        points.append(p)
    points[0] = list(start)
    points[-1] = list(end)
    length = math.hypot(r * abs(sweep), dn)
    return ArcResult(center=center, radius=r, sweep=sweep, points=points, length=length, radius_error=abs(r1 - r0))


def dogleg_points(start, end):
    """Non-interpolated rapid: every axis moves at the same rapid rate independently."""
    deltas = [end[i] - start[i] for i in range(3)]
    order = sorted({abs(d) for d in deltas if abs(d) > 1e-9})
    points = [list(start)]
    for travel in order:
        p = [start[i] + math.copysign(min(abs(deltas[i]), travel), deltas[i]) for i in range(3)]
        points.append(p)
    if len(points) == 1:
        points.append(list(end))
    points[-1] = list(end)
    return points


def distance(p, q):
    return math.dist(p, q)


def polyline_length(points):
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
