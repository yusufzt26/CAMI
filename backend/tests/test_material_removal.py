import math

import numpy as np
import pytest

from app.gcode import InterpreterSettings
from app.gcode.lexer import tokenize
from app.material_removal import Grid, StockSetup, ToolSpec, ZMap, tool_hints_from_comments
from app.verification import verify


def zmap(size=(100.0, 100.0, 20.0)):
    return ZMap(Grid.for_box((-size[0] / 2, -size[1] / 2, -size[2]), (size[0] / 2, size[1] / 2, 0.0)))


def height_at(z: ZMap, x, y):
    g = z.grid
    i = int((x - g.x0) / g.cx)
    j = int((y - g.y0) / g.cy)
    return z.height[j, i]


def test_flat_slot_volume_and_depth():
    z = zmap()
    tool = ToolSpec(1, "flat", 10.0).normalised()
    r = z.apply_segment((-30, 0, -2), (30, 0, -2), tool)
    expected = (60 * 10 + math.pi * 25) * 2  # slot + rounded ends
    assert r.removed_volume == pytest.approx(expected, rel=0.03)
    assert height_at(z, 0, 0) == pytest.approx(-2)
    assert height_at(z, 0, 8) == pytest.approx(0)


def test_ball_nose_profile():
    z = zmap()
    tool = ToolSpec(1, "ball", 10.0).normalised()
    z.apply_segment((-30, 0, -5), (30, 0, -5), tool)
    assert height_at(z, 0, 0) == pytest.approx(-5, abs=0.05)
    # 3 mm off-centre a R5 ball is R - sqrt(R^2 - 9) = 1 mm higher
    assert height_at(z, 0, 3) == pytest.approx(-4, abs=0.15)


def test_bull_nose_and_drill_point():
    z = zmap()
    bull = ToolSpec(1, "bull", 10.0, 2.0).normalised()
    z.apply_segment((0, 0, -3), (0, 0, -3), bull)
    assert height_at(z, 0, 0) == pytest.approx(-3)
    assert height_at(z, 4.6, 0) > -3 + 0.3  # in the corner radius
    z2 = zmap()
    drill = ToolSpec(2, "drill", 10.0, point_angle=118).normalised()
    z2.apply_segment((0, 0, 5), (0, 0, -10), drill)
    assert height_at(z2, 0, 0) == pytest.approx(-10, abs=0.2)
    assert height_at(z2, 4, 0) == pytest.approx(-10 + 4 / math.tan(math.radians(59)), abs=0.2)


def test_ramp_flat_takes_lowest_end():
    z = zmap()
    tool = ToolSpec(1, "flat", 10.0).normalised()
    z.apply_segment((-20, 0, 0), (20, 0, -4), tool)
    # Cell under the end of the ramp is cut to the lowest tool position covering it.
    assert height_at(z, 20, 0) == pytest.approx(-4, abs=0.1)
    assert height_at(z, 0, 0) == pytest.approx(-2 - 5 * 4 / 40, abs=0.15)


def test_cuts_are_order_independent():
    tool = ToolSpec(1, "ball", 8.0).normalised()
    segs = [((-30, -10, -1), (30, 10, -3)), ((0, -30, -2), (0, 30, -2)), ((10, 10, -6), (10, 10, -6))]
    a, b = zmap(), zmap()
    for s in segs:
        a.apply_segment(*s, tool)
    for s in reversed(segs):
        b.apply_segment(*s, tool)
    # Equal up to the 0.01 mm cut tolerance.
    assert np.allclose(a.height, b.height, atol=0.011)


def test_tool_hints():
    text = "(T1 D50 FACE MILL / T2 D=10. CR=1. - BULL / T3 D=8.5 TAPER=118DEG - DRILL)\nT4 M06 (M10 X 1.5 TAP)\nT5 M06 (6MM BALL)\n"
    hints = tool_hints_from_comments(tokenize(text))
    assert hints[1] == {"description": "D50 FACE MILL", "type": "face", "diameter": 50.0}
    assert hints[2]["type"] == "bull" and hints[2]["corner_radius"] == 1.0
    assert hints[3]["type"] == "drill" and hints[3]["diameter"] == 8.5
    assert hints[4]["type"] == "tap" and hints[4]["diameter"] == 10.0
    assert hints[5]["type"] == "ball" and hints[5]["diameter"] == 6.0


HEAD = "(T1 D10 FLAT END MILL)\nG90 G17 G21 G54\nT1 M06\nS3000 M03\nG00 G43 H1 Z20.\n"


def run(body, **stock):
    return verify(HEAD + body + "\nM30\n", InterpreterSettings(), StockSetup(**stock), {})


def codes(r):
    return [d["code"] for d in r["diagnostics"]]


def test_rapid_into_stock_is_error():
    r = run("G00 X0. Y0.\nZ-5.")
    assert "RAPID_IN_STOCK" in codes(r)
    assert r["summary"]["status"] == "errors"


def test_below_stock_bottom_warning():
    r = run("G00 X0. Y0. Z2.\nG01 Z-45. F100.", size=(100.0, 100.0, 40.0))
    assert "BELOW_STOCK_BOTTOM" in codes(r)


def test_clean_pocket_has_no_stock_findings_and_reports_volume():
    r = run("G00 X0. Y0. Z2.\nG01 Z-3. F100.\nX20. F500.\nG00 Z20.", size=(100.0, 100.0, 40.0))
    assert not {"RAPID_IN_STOCK", "BELOW_STOCK_BOTTOM"} & set(codes(r))
    st = r["stock"]
    assert st["removed_volume"] == pytest.approx(math.pi * 25 * 3 + 20 * 10 * 3, rel=0.03)
    assert st["initial_volume"] == pytest.approx(100 * 100 * 40, rel=1e-6)


def test_assumed_tool_is_warned_and_overridable():
    body = "G90 G17 G21 G54\nT7 M06\nS3000 M03\nG00 G43 H7 Z5.\nG01 Z-1. F100.\nM30"
    r = verify(body, InterpreterSettings(), StockSetup(), {})
    assert "TOOL_ASSUMED" in codes(r)
    r2 = verify(body, InterpreterSettings(), StockSetup(), {"7": {"type": "ball", "diameter": 6.0}})
    assert "TOOL_ASSUMED" not in codes(r2)
    assert r2["tools"][0]["type"] == "ball" and r2["tools"][0]["source"] == "user"


def test_tool_from_header_comments_when_program_has_no_t_word():
    from app.gcode.lexer import tokenize
    from app.material_removal import resolve_tools, tool_hints_from_comments

    text = (
        "O0043(46)\n(Operation TYPE=Z-Level Finishing)\n(Tool Type : Bull-nose )\n"
        "(TOOL DIA : 19.9 ,CORNER RAD : 0.8)\n(Recommended Safe Tool Length= 48.000 )\n"
        "N1 (ToolDia:19.9,CornerRad:0.8)\nN3 G00 G91 G28 Z0.0\nN4 G05 P10000\nN8 G01 X0.5 Y-150. F8000\n"
    )
    hints = tool_hints_from_comments(tokenize(text))
    spec = resolve_tools([None], hints, {})[None]
    assert (spec.type, spec.diameter, spec.corner_radius, spec.source) == ("bull", 19.9, 0.8, "comment")

    drill = tool_hints_from_comments(tokenize("(Tool Type : Centering Drill )\n(TOOL DIA : 6. ,CORNER RAD : 0.)\nG0 X0 Y0\n"))
    assert resolve_tools([None], drill, {})[None].type == "spot"


def test_set_carries_stock_between_programs():
    from app.gcode import InterpreterSettings
    from app.material_removal import StockSetup
    from app.verification import verify

    stock = StockSetup(size=(100.0, 100.0, 20.0))
    rough = "(T1 D10 FLAT END MILL)\nG90 G17 G21 G54\nT1 M06\nS1000 M03\nG0 G43 H1 X-20. Y0 Z5.\nG1 Z-5. F500.\nX20.\nG0 Z5.\nM30\n"
    # Second program rapids down into the slot the first one cut.
    finish = "(T2 D8 FLAT END MILL)\nG90 G17 G21 G54\nT2 M06\nS1000 M03\nG0 G43 H2 X0 Y0 Z5.\nG0 Z-4.\nG1 Z-6. F300.\nG0 Z5.\nM30\n"
    alone = verify(finish, InterpreterSettings(), stock, {})
    assert any(d["code"] == "RAPID_IN_STOCK" for d in alone["diagnostics"])
    first = verify(rough, InterpreterSettings(), stock, {})
    after = verify(finish, InterpreterSettings(), stock, {}, start=first["_zmap"])
    assert not any(d["code"] == "RAPID_IN_STOCK" for d in after["diagnostics"])
    assert 0 < after["stock"]["removed_volume"] < alone["stock"]["removed_volume"]


def test_clear_endpoint_removes_all_programs():
    import os
    import tempfile

    os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/t.db")
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        client.post("/api/programs", files={"file": ("a.nc", b"G0 X1.\nM30\n", "text/plain")})
        assert client.get("/api/programs").json()
        assert client.delete("/api/programs").status_code == 204
        assert client.get("/api/programs").json() == []
