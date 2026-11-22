"""Cutter radius compensation (G41/G42) in the XY plane, FANUC style.

The interpreter hands every XY motion made while compensation is engaged to
this class. Each element's compensated end point depends on the *next*
element (inner corners use the intersection of the two offset paths, outer
corners get a connecting arc around the programmed corner), so one element is
held back until the next one arrives. Z-only moves in between are queued and
replayed in order.

Start-up (type A): the start-up move ends at the programmed point offset by
the normal of the following element. Cancel: the element before the G40 move
ends at its own end normal, then the G40 move goes to the programmed point.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

from .geometry import build_arc

EPS = 1e-9


@dataclass
class Element:
    kind: str  # "line" | "arc"
    motion: str  # "rapid" | "feed" | "arc"
    p0: list[float]  # programmed start (machine coords)
    p1: list[float]  # programmed end
    block: object
    feed: float | None
    center: list[float] | None = None
    cw: bool = False
    startup: bool = False
    q0: list[float] | None = None  # compensated start (x, y)
    queue: list[Callable[[], None]] = field(default_factory=list)


def _unit(x, y):
    n = math.hypot(x, y)
    return (x / n, y / n) if n > EPS else (0.0, 0.0)


def tangent(el: Element, at_end: bool):
    if el.kind == "line":
        return _unit(el.p1[0] - el.p0[0], el.p1[1] - el.p0[1])
    p = el.p1 if at_end else el.p0
    rx, ry = p[0] - el.center[0], p[1] - el.center[1]
    return _unit(ry, -rx) if el.cw else _unit(-ry, rx)


def _cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def _line_circle(p, d, c, r):
    """Intersections of the infinite line p + t d with circle (c, r)."""
    fx, fy = p[0] - c[0], p[1] - c[1]
    a = d[0] ** 2 + d[1] ** 2
    b = 2 * (fx * d[0] + fy * d[1])
    cc = fx * fx + fy * fy - r * r
    disc = b * b - 4 * a * cc
    if disc < -1e-9 or a < EPS:
        return []
    s = math.sqrt(max(disc, 0.0))
    return [(p[0] + t * d[0], p[1] + t * d[1]) for t in ((-b - s) / (2 * a), (-b + s) / (2 * a))]


def _circle_circle(c1, r1, c2, r2):
    dx, dy = c2[0] - c1[0], c2[1] - c1[1]
    d = math.hypot(dx, dy)
    if d < EPS or d > r1 + r2 + 1e-9 or d < abs(r1 - r2) - 1e-9:
        return []
    a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
    h = math.sqrt(max(r1 * r1 - a * a, 0.0))
    mx, my = c1[0] + a * dx / d, c1[1] + a * dy / d
    return [(mx + h * dy / d, my - h * dx / d), (mx - h * dy / d, my + h * dx / d)]


class CompError(Exception):
    pass


class CutterComp:
    def __init__(self, emit_line, emit_arc, arc_tolerance):
        # emit_line(block, kind, start_xyz, end_xyz, feed); emit_arc(block, start, end, center, cw, feed, points, length)
        self.emit_line = emit_line
        self.emit_arc = emit_arc
        self.tol = arc_tolerance
        self.side = 0  # +1 = G41 (tool left of path), -1 = G42
        self.radius = 0.0
        self.pending: Element | None = None
        self.warnings: list[tuple[object, str, str]] = []  # (block, code, message)

    # ------------------------------------------------------------ geometry
    def normal(self, el: Element, at_end: bool):
        t = tangent(el, at_end)
        return (-t[1] * self.side, t[0] * self.side)

    def offset_radius(self, el: Element) -> float:
        ra = math.hypot(el.p0[0] - el.center[0], el.p0[1] - el.center[1])
        center_left = not el.cw
        inside = center_left == (self.side > 0)
        r = ra - self.radius if inside else ra + self.radius
        if r <= 1e-6:
            raise CompError(
                f"Arc radius {ra:.3f} mm is smaller than the cutter radius {self.radius:.3f} mm on the inside of the arc (controller alarm)."
            )
        return r

    def _offset_point(self, p, n):
        return (p[0] + n[0] * self.radius, p[1] + n[1] * self.radius)

    def _intersection(self, a: Element, b: Element, near):
        if a.kind == "line" and b.kind == "line":
            pa = self._offset_point(a.p1, self.normal(a, True))
            pb = self._offset_point(b.p0, self.normal(b, False))
            da, db = tangent(a, True), tangent(b, False)
            den = _cross(da, db)
            if abs(den) < 1e-12:
                return None
            t = _cross((pb[0] - pa[0], pb[1] - pa[1]), db) / den
            return [(pa[0] + t * da[0], pa[1] + t * da[1])]
        if a.kind == "line" or b.kind == "line":
            line, arc = (a, b) if a.kind == "line" else (b, a)
            pl = self._offset_point(line.p0, self.normal(line, False))
            pts = _line_circle(pl, tangent(line, False), arc.center, self.offset_radius(arc))
        else:
            pts = _circle_circle(a.center, self.offset_radius(a), b.center, self.offset_radius(b))
        if not pts:
            return None
        return [min(pts, key=lambda p: math.hypot(p[0] - near[0], p[1] - near[1]))]

    # -------------------------------------------------------------- driving
    def engage(self, side: int, radius: float):
        self.side = side
        self.radius = radius

    @property
    def active(self) -> bool:
        return self.side != 0

    def add(self, el: Element, actual_xy):
        """Add an XY element made while compensation is engaged."""
        if self.pending is None:
            el.q0 = tuple(actual_xy)
            if not el.startup:
                # Compensation already on but nothing pending (e.g. after a flush): start on the offset.
                el.q0 = self._offset_point(el.p0, self.normal(el, False))
                if math.hypot(el.q0[0] - actual_xy[0], el.q0[1] - actual_xy[1]) > 1e-6:
                    self._emit_line_to(el.block, el.motion if el.motion != "arc" else "feed", actual_xy, el.q0, el.p0[2], el.p0[2], el.feed)
            self.pending = el
            return
        a = self.pending
        if a.startup:
            q = self._offset_point(a.p1, self.normal(el, False))
            self._emit_element(a, q)
            el.q0 = q
        else:
            nA, nB = self.normal(a, True), self.normal(el, False)
            corner = a.p1
            if math.hypot(nA[0] - nB[0], nA[1] - nB[1]) < 1e-7:
                q = self._offset_point(corner, nA)
                self._emit_element(a, q)
                el.q0 = q
            else:
                cross = _cross(tangent(a, True), tangent(el, False))
                inner = cross * self.side > 1e-12
                if inner:
                    near = (corner[0] + (nA[0] + nB[0]) * self.radius / 2, corner[1] + (nA[1] + nB[1]) * self.radius / 2)
                    pts = self._intersection(a, el, near)
                    if not pts:
                        raise CompError("No intersection between the offset paths at an inside corner (cutter radius too large).")
                    q = pts[0]
                    self._emit_element(a, q)
                    el.q0 = q
                else:
                    qa = self._offset_point(corner, nA)
                    qb = self._offset_point(corner, nB)
                    self._emit_element(a, qa, run_queue=False)
                    cw = cross < 0 if abs(cross) > 1e-12 else self.side > 0
                    self._emit_corner(a.block, qa, qb, corner, cw, a.p1[2], a.feed, a.motion)
                    self._run_queue(a)
                    el.q0 = qb
        self.pending = el

    def queue(self, fn: Callable[[], None]) -> bool:
        """Queue a non-XY move behind the pending element. Returns False if nothing is pending."""
        if self.pending is None:
            return False
        self.pending.queue.append(fn)
        return True

    def flush(self):
        """Finish the pending element on its own end normal (cancel, non-XY block, program end)."""
        a = self.pending
        if a is None:
            return
        self.pending = None
        n = self.normal(a, True)
        self._emit_element(a, self._offset_point(a.p1, n))

    def cancel(self):
        self.flush()
        self.side = 0

    # ------------------------------------------------------------- emitting
    def _emit_element(self, el: Element, q1, run_queue: bool = True):
        q0 = el.q0
        if el.kind == "line" or el.startup:
            if el.kind == "line" and not el.startup:
                prog = (el.p1[0] - el.p0[0], el.p1[1] - el.p0[1])
                comp = (q1[0] - q0[0], q1[1] - q0[1])
                if prog[0] * comp[0] + prog[1] * comp[1] < -1e-9:
                    self.warnings.append(
                        (el.block, "COMP_INTERFERENCE", "Cutter compensation reverses this move: the element is shorter than the cutter radius allows (overcut / gouge).")
                    )
            self._emit_line_to(el.block, el.motion if el.motion != "arc" else "feed", q0, q1, el.p0[2], el.p1[2], el.feed)
        else:
            r = self.offset_radius(el)
            start = [q0[0], q0[1], el.p0[2]]
            end = [q1[0], q1[1], el.p1[2]]
            center = [el.center[0], el.center[1], el.p0[2]]
            # Keep the arc on the offset circle even if rounding moved the points slightly.
            for p in (start, end):
                vx, vy = p[0] - center[0], p[1] - center[1]
                d = math.hypot(vx, vy)
                if d > EPS:
                    p[0], p[1] = center[0] + vx / d * r, center[1] + vy / d * r
            arc = build_arc(start, end, center, el.cw, "G17", self.tol)
            self.emit_arc(el.block, start, end, center, el.cw, el.feed, arc.points, arc.length)
        if run_queue:
            self._run_queue(el)

    @staticmethod
    def _run_queue(el: Element):
        queued, el.queue = el.queue, []
        for fn in queued:
            fn()

    def _emit_line_to(self, block, kind, q0, q1, z0, z1, feed):
        self.emit_line(block, kind, [q0[0], q0[1], z0], [q1[0], q1[1], z1], feed)

    def _emit_corner(self, block, qa, qb, corner, cw, z, feed, motion):
        start = [qa[0], qa[1], z]
        end = [qb[0], qb[1], z]
        center = [corner[0], corner[1], z]
        if motion == "rapid":
            self.emit_line(block, "rapid", start, end, feed)
            return
        arc = build_arc(start, end, center, cw, "G17", self.tol, full_circle_allowed=False)
        self.emit_arc(block, start, end, center, cw, feed, arc.points, arc.length)
