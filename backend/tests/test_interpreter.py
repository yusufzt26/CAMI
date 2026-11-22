import math
from pathlib import Path

import pytest

from app.gcode import InterpreterSettings, interpret
from app.gcode.lexer import tokenize

SAMPLES = Path(__file__).resolve().parents[2] / "samples"
HEADER = "G90 G17 G21 G54\nT1 M06\nS1000 M03\nG00 G43 H1 Z50.\n"


def run(body, **settings):
    return interpret(HEADER + body + "\nM30\n", InterpreterSettings(**settings))


def codes(result):
    return [d["code"] for d in result.diagnostics]


def cutting(result):
    return [m for m in result.moves if m["kind"] in ("feed", "arc")]


# ---------------------------------------------------------------- lexer
def test_lexer_comments_sequence_and_words():
    blocks = tokenize("%\nO1234 (MAIN)\nN10 G01 X10.5 Y-2 ; move\n/N20 Z1.\n")
    assert blocks[0].program_number == "1234" and blocks[0].comment == "MAIN"
    b = blocks[1]
    assert b.sequence == 10 and [w.code for w in b.words if w.letter == "G"] == ["G1"]
    assert b.get("X").value == 10.5 and not b.get("Y").has_decimal_point
    assert b.comment == "move"
    assert blocks[2].block_delete


def test_lexer_flags_macro_and_garbage():
    blocks = tokenize("#100=5.\nG01 X1. $$\n")
    assert blocks[0].macro
    assert blocks[1].lex_errors


# ---------------------------------------------------------------- motion
def test_linear_moves_and_time():
    r = run("G00 X0. Y0. Z5.\nG01 Z-1. F100.\nX100. F600.")
    cuts = cutting(r)
    assert len(cuts) == 2
    assert cuts[1]["end"] == [100.0, 0.0, -1.0]
    assert math.isclose(cuts[1]["duration"], 10.0)  # 100 mm at 600 mm/min
    assert r.summary["status"] == "ok"


def test_incremental_mode():
    r = run("G00 X0. Y0. Z5.\nG91 G01 X10. Y5. F100.\nX10.\nG90")
    assert cutting(r)[-1]["end"] == [20.0, 5.0, 5.0]


def test_inch_units_converted_to_mm():
    r = interpret("G90 G17 G20 G54\nT1 M06\nS1000 M03\nG43 H1 Z2.\nG01 X1. F10.\nM30\n")
    m = cutting(r)[-1]
    assert math.isclose(m["end"][0], 25.4)
    assert math.isclose(m["feed"], 254.0)


def test_arc_ijk_quarter_circle_ccw():
    r = run("G00 X10. Y0. Z0.\nG03 X0. Y10. I-10. J0. F100.")
    arc = cutting(r)[-1]
    assert arc["kind"] == "arc"
    assert math.isclose(arc["length"], math.pi * 10 / 2, rel_tol=1e-6)
    mid = arc["points"][len(arc["points"]) // 2]
    assert math.isclose(math.hypot(mid[0], mid[1]), 10, abs_tol=1e-3)
    assert mid[0] > 0 and mid[1] > 0  # CCW from +X to +Y passes through Q1


def test_arc_r_format_cw_and_large_arc():
    small = run("G00 X0. Y0. Z0.\nG02 X20. Y0. R10. F100.")
    assert math.isclose(cutting(small)[-1]["length"], math.pi * 10, rel_tol=1e-6)
    big = run("G00 X0. Y0. Z0.\nG02 X10. Y10. R-10. F100.")
    assert math.isclose(cutting(big)[-1]["length"], 1.5 * math.pi * 10, rel_tol=1e-6)


def test_full_circle_and_helix():
    r = run("G00 X10. Y0. Z0.\nG02 X10. Y0. I-10. J0. Z-2. F100.")
    arc = cutting(r)[-1]
    assert math.isclose(arc["length"], math.hypot(2 * math.pi * 10, 2), rel_tol=1e-6)
    assert arc["points"][len(arc["points"]) // 2][2] == pytest.approx(-1.0, abs=0.05)


def test_arc_g18_plane():
    # In G18 the arc is viewed from +Y: going from +X to +Z is clockwise (G02).
    r = run("G18\nG00 X10. Y0. Z0.\nG02 X0. Z10. I-10. K0. F100.\nG17")
    arc = cutting(r)[-1]
    assert all(abs(p[1]) < 1e-9 for p in arc["points"])
    assert math.isclose(arc["length"], math.pi * 5, rel_tol=1e-6)


def test_arc_radius_mismatch_halts():
    r = run("G00 X10. Y0. Z0.\nG03 X0. Y10.5 I-10. J0. F100.")
    assert r.summary["status"] == "halted" and "ARC_RADIUS" in codes(r)


def test_arc_r_too_small_halts():
    r = run("G00 X0. Y0. Z0.\nG02 X30. Y0. R10. F100.")
    assert r.summary["status"] == "halted" and "ARC_INVALID" in codes(r)


# ---------------------------------------------------------------- safety
@pytest.mark.parametrize(
    "line,code",
    [
        ("G68 X0. Y0. R45.", "UNSUPPORTED_CODE"),
        ("M98 P1000", "UNSUPPORTED_CODE"),
        ("G123", "UNKNOWN_CODE"),
        ("M77", "UNKNOWN_CODE"),
        ("G01 A90. F100.", "FOREIGN_AXIS"),
        ("#1=10.", "MACRO"),
        ("G01 X1. X2. F100.", "DUPLICATE_ADDRESS"),
        ("G00 G01 X1.", "MODAL_CONFLICT"),
    ],
)
def test_unsafe_codes_stop_verification(line, code):
    r = run(f"G00 X0. Y0.\n{line}\nG00 X50.")
    assert r.summary["status"] == "halted"
    assert code in codes(r)
    halted = [b for b in r.blocks if b["status"] == "halted"]
    assert len(halted) == 1 and line.split()[0] in halted[0]["text"]
    assert all(b["status"] == "not_run" for b in r.blocks[halted[0]["index"] + 1 :])


def test_missing_feed_halts():
    r = interpret("G90 G17 G21 G54\nT1 M06\nS1000 M03\nG01 X10.\nM30")
    assert "NO_FEED" in codes(r) and r.summary["status"] == "halted"


def test_spindle_off_cutting_is_error():
    r = interpret("G90 G17 G21 G54\nT1 M06\nG43 H1 Z5.\nG01 X10. F100.\nM30")
    assert "SPINDLE_OFF_CUT" in codes(r) and r.summary["status"] == "errors"


def test_no_decimal_point_warning_and_least_increment_mode():
    r = run("G00 X10 Y0.")
    assert "NO_DECIMAL_POINT" in codes(r)
    assert r.moves[-1]["end"][0] == 10.0
    r2 = run("G00 X10 Y0.", decimal_mode="least_increment")
    assert r2.moves[-1]["end"][0] == pytest.approx(0.01)


def test_missing_safety_block_warns():
    r = interpret("T1 M06\nS1000 M03\nG43 H1 Z5.\nG01 X10. F100.\nM30")
    assert "NO_SAFETY_BLOCK" in codes(r)


def test_h_mismatch_and_missing_g43():
    r = interpret("G90 G17 G21 G54\nT2 M06\nS1000 M03\nG00 Z10.\nG43 H3 Z5.\nM30")
    assert "NO_G43" in codes(r) and "H_MISMATCH" in codes(r)


def test_cutter_comp_on_arc_halts():
    r = run("G00 X0. Y0. Z0.\nG01 X10. F100.\nG41 D1 G02 X20. Y0. R5.")
    assert "COMP_ON_ARC" in codes(r)


def test_block_delete_switch():
    off = run("G00 X0. Y0.\n/G00 X99.")
    assert off.moves[-1]["end"][0] == 99.0 and "BLOCK_DELETE" in codes(off)
    on = run("G00 X0. Y0.\n/G00 X99.", block_delete_switch=True)
    assert on.moves[-1]["end"][0] == 0.0


# ---------------------------------------------------------------- reference / wcs
def test_g28_via_intermediate_point():
    r = run("G00 X10. Y10. Z5.\nG91 G28 Z0.\nG90", reference_position=[0.0, 0.0, 120.0])
    ref = [m for m in r.moves if m["op"] == "reference"]
    assert ref[-1]["end"] == [10.0, 10.0, 120.0]
    assert "REFERENCE_ASSUMED" in codes(r)


def test_work_offsets_shift_display_frame():
    offs = {c: [0.0, 0.0, 0.0] for c in ("G54", "G55", "G56", "G57", "G58", "G59")}
    offs["G55"] = [100.0, 0.0, 0.0]
    r = run("G00 X0. Y0. Z5.\nG55 G00 X0. Y0.", work_offsets=offs)
    assert r.moves[-1]["end"][0] == 100.0


def test_dogleg_rapid_points():
    r = run("G00 X0. Y0. Z50.\nG00 X100. Y20. Z10.", rapid_mode="dogleg")
    pts = r.moves[-1]["points"]
    assert pts[1] == [20.0, 20.0, 30.0]  # Y finishes first
    assert pts[-1] == [100.0, 20.0, 10.0]


# ---------------------------------------------------------------- cycles
def test_g81_g98_g99_returns():
    r = run("G00 X0. Y0. Z50.\nG99 G81 X10. Y10. Z-5. R2. F100.\nG98 X20.\nG80")
    drill_feeds = [m for m in r.moves if m["op"] == "drill" and m["kind"] == "feed"]
    assert [m["end"] for m in drill_feeds] == [[10.0, 10.0, -5.0], [20.0, 10.0, -5.0]]
    assert r.moves[-1]["end"] == [20.0, 10.0, 50.0]  # G98 back to initial level
    first_return = [m for m in r.moves if m["block"] == drill_feeds[0]["block"]][-1]
    assert first_return["end"][2] == 2.0  # G99 to R
    assert r.summary["holes"] == {"drill": 2}


def test_g83_peck_count():
    r = run("G00 X0. Y0. Z10.\nG98 G83 X0. Y0. Z-12. R2. Q5. F100.\nG80")
    pecks = [m for m in r.moves if m.get("note") == "peck"]
    assert [round(p["end"][2], 3) for p in pecks] == [-3.0, -8.0, -12.0]


def test_g84_tap_requires_cw():
    r = run("M04\nG00 X0. Y0. Z10.\nG84 X0. Y0. Z-10. R3. F150.\nG80")
    assert "TAP_DIRECTION" in codes(r)


def test_incremental_cycle_with_repeat():
    r = run("G00 X0. Y0. Z10.\nG91 G99 G81 X10. Z-15. R-8. K3 F100.\nG90 G80")
    feeds = [m for m in r.moves if m["op"] == "drill" and m["kind"] == "feed"]
    assert [f["end"] for f in feeds] == [[10.0, 0.0, -13.0], [20.0, 0.0, -13.0], [30.0, 0.0, -13.0]]


def test_cycle_depth_above_r_halts():
    r = run("G00 X0. Y0. Z10.\nG81 X0. Y0. Z5. R2. F100.")
    assert "CYCLE_DEPTH" in codes(r)


# ---------------------------------------------------------------- samples
def test_demo_program_runs_clean():
    r = interpret((SAMPLES / "mould_plate_demo.nc").read_text())
    assert r.summary["status"] == "warnings"
    assert r.summary["errors"] == 0
    assert r.summary["tool_changes"] == 4
    assert r.summary["holes"] == {"drill": 4, "tap": 4}
    assert r.summary["verification_complete"] is False


def test_unsafe_sample_halts_at_g68():
    r = interpret((SAMPLES / "unsafe_examples.nc").read_text())
    assert r.summary["status"] == "halted" and r.summary["halted_at_line"] == 9


def test_g05_p10000_is_accepted_other_g05_halts():
    from app.gcode import interpret

    ok = interpret("G90 G17 G21 G54\nG05 P10000\nG0 X10.\nG05 P0\nM30\n")
    assert ok.summary["status"] != "halted"
    assert ok.moves[-1]["end"][0] == 10.0
    assert any(d["code"] == "NO_EFFECT" and "G05" in d["message"] for d in ok.diagnostics)
    for bad in ("G05 P2\n", "G05\n", "G05 P10000 X5.\n"):
        r = interpret("G90 G17 G21 G54\n" + bad + "M30\n")
        assert r.summary["status"] == "halted", bad
        assert r.summary["halted_at_line"] == 2
