import math

import pytest

from app.gcode import InterpreterSettings, interpret

HEAD = "G90 G17 G21 G54\nT1 M06\nS1000 M03\nG00 G43 H1 Z5.\nG00 X-20. Y-20.\nG01 Z-1. F100.\n"


def run(body, radius=5.0, **kw):
    s = InterpreterSettings(comp_radii={1: radius}, **kw)
    return interpret(HEAD + body + "\nG00 Z5.\nM30\n", s)


def path(r):
    return [m for m in r.moves if m["kind"] in ("feed", "arc") and m["line"] > 6]


def codes(r):
    return [d["code"] for d in r.diagnostics]


def test_outside_square_g41_climb_has_corner_arcs():
    # Square 0..40 cut clockwise with G41: tool outside the part.
    r = run("G41 D1 G01 X0. Y0.\nY40.\nX40.\nY0.\nX0.\nG40 G01 X-20. Y-20.")
    p = path(r)
    lines = [m for m in p if m["kind"] == "feed"]
    arcs = [m for m in p if m["kind"] == "arc"]
    assert lines[1]["start"][:2] == [-5.0, 0.0] and lines[1]["end"][:2] == [-5.0, 40.0]
    assert lines[2]["start"][:2] == [0.0, 45.0] and lines[2]["end"][:2] == [40.0, 45.0]
    assert len(arcs) == 3 and all("R5.000" in a["note"] for a in arcs)
    assert r.summary["status"] in ("ok", "warnings")


def test_inside_corner_uses_intersection():
    # Square pocket 0..40 cut counter-clockwise with G41: tool inside, sharp corners.
    r = run("G00 X20. Y20.\nG41 D1 G01 X20. Y0.\nX40.\nY40.\nX0.\nY0.\nX20.\nG40 X20. Y20.")
    ends = [tuple(m["end"][:2]) for m in path(r) if m["kind"] == "feed"]
    for corner in [(35.0, 5.0), (35.0, 35.0), (5.0, 35.0), (5.0, 5.0)]:
        assert corner in ends
    assert not [m for m in path(r) if m["kind"] == "arc"]


def test_arc_offset_inside_and_alarm_when_too_small():
    ok = run("G00 X0. Y0.\nG41 D1 G01 X10. Y0.\nG03 X10. Y0. I-10. J0.\nG40 G01 X0. Y0.")
    arc = [m for m in path(ok) if m["kind"] == "arc"][0]
    assert "R5.000" in arc["note"]  # 10 - 5 on the inside
    bad = run("G00 X0. Y0.\nG41 D1 G01 X3. Y0.\nG03 X3. Y0. I-3. J0.\nG40 G01 X0. Y0.")
    assert bad.summary["status"] == "halted" and "COMP_ERROR" in codes(bad)


def test_wear_mode_keeps_programmed_path():
    r = run("G41 D1 G01 X0. Y0.\nY40.\nG40 X-20.", cutter_comp_mode="zero")
    assert [m["end"][:2] for m in path(r)][:2] == [[0.0, 0.0], [0.0, 40.0]]


def test_z_move_between_xy_moves_stays_in_order():
    r = run("G41 D1 G01 X0. Y0.\nY40.\nZ-2.\nX40.\nG40 X60. Y60.")
    lines = [(m["line"], m["end"]) for m in path(r)]
    order = [ln for ln, _ in lines]
    assert order == sorted(order)
    z_move = [e for ln, e in lines if ln == 9][0]
    # The Z move runs after the outer-corner arc, at the start of the next offset element.
    assert z_move == [0.0, 45.0, -2.0]
