import os
import tempfile

os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkdtemp()}/test.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def test_upload_and_interpret():
    with TestClient(app) as client:
        body = b"(T1 D10 FLAT END MILL)\nG90 G17 G21 G54\nT1 M06\nS1000 M03\nG00 G43 H1 Z5.\nG01 X10. F100.\nM30\n"
        r = client.post("/api/programs", files={"file": ("part.NC", body, "text/plain")})
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        r = client.post(f"/api/programs/{pid}/interpret", json={})
        assert r.status_code == 200
        data = r.json()
        assert data["summary"]["status"] == "ok"
        assert data["moves"][-1]["end"] == [10.0, 0.0, 5.0]
        assert client.get("/api/programs").json()[0]["last_status"] == "ok"


def test_rejects_wrong_extension_and_binary():
    with TestClient(app) as client:
        assert client.post("/api/programs", files={"file": ("part.exe", b"G0 X1", "x")}).status_code == 400
        assert client.post("/api/programs", files={"file": ("part.nc", b"\x00\x01\x02", "x")}).status_code == 400


def test_controller_table():
    with TestClient(app) as client:
        data = client.get("/api/controllers/fanuc").json()
        assert any(c["code"] == "G83" for c in data["g_codes"])


def _zip(entries):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_upload_zip_stores_every_program():
    with TestClient(app) as client:
        data = _zip(
            {
                "job/OP20.nc": "G90 G17 G21 G54\nG0 X1.\nM30\n",
                "job/OP10.TAP": "G90 G17 G21 G54\nG0 X2.\nM30\n",
                "job/O1234": "G90 G17 G21 G54\nG0 X3.\nM30\n",
                "job/readme.pdf": b"%PDF-1.4",
                "__MACOSX/job/._OP10.TAP": b"\x00\x05",
            }
        )
        r = client.post("/api/programs", files={"file": ("job.zip", data, "application/zip")})
        assert r.status_code == 201, r.text
        assert r.json()["filename"] == "O1234.nc"
        names = {p["filename"] for p in client.get("/api/programs").json()}
        assert {"OP10.TAP", "OP20.nc", "O1234.nc"} <= names
        assert "readme.pdf" not in names


def test_upload_zip_without_programs_is_rejected():
    with TestClient(app) as client:
        r = client.post("/api/programs", files={"file": ("x.zip", _zip({"a.pdf": b"%PDF"}), "application/zip")})
        assert r.status_code == 400
        assert "no G-code programs" in r.json()["detail"]
        assert client.post("/api/programs", files={"file": ("bad.zip", b"not a zip", "application/zip")}).status_code == 400
