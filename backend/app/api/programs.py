import io
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES
from ..db import Program, get_session
from ..gcode import InterpreterSettings
from ..material_removal import StockSetup
from ..verification import verify
from ..gcode.controllers import available_dialects, get_dialect
from ..schemas import ProgramDetail, ProgramOut, SetupIn

router = APIRouter(prefix="/api")


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise HTTPException(400, "File is not readable text")


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/controllers")
def controllers():
    return available_dialects()


@router.get("/controllers/{key}")
def controller_codes(key: str):
    try:
        return get_dialect(key).describe()
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


def _check_text(raw: bytes, name: str) -> str:
    if not raw.strip():
        raise HTTPException(400, f"{name} is empty")
    if b"\x00" in raw[:4096]:
        raise HTTPException(400, f"{name} looks binary, not a G-code text file")
    return _decode(raw)


def _programs_from_zip(raw: bytes, archive: str) -> list[tuple[str, bytes]]:
    """NC programs inside a zip, in name order. Files with no extension (O1234) count too."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise HTTPException(400, f"{archive} is not a valid zip archive") from exc
    out = []
    total = 0
    for info in zf.infolist():
        p = PurePosixPath(info.filename)
        if info.is_dir() or p.parts[0] == "__MACOSX" or p.name.startswith("."):
            continue
        ext = p.suffix.lower()
        if ext not in ALLOWED_EXTENSIONS and ext != "":
            continue
        if info.file_size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"{p.name} in {archive} is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
        total += info.file_size
        if total > 4 * MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"{archive} unpacks to more than {4 * MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
        data = zf.read(info)
        if not data.strip() or b"\x00" in data[:4096]:
            continue
        out.append((p.name if ext else p.name + ".nc", data))
    if not out:
        raise HTTPException(400, f"{archive} has no G-code programs inside (looked for {', '.join(sorted(ALLOWED_EXTENSIONS))})")
    return sorted(out, key=lambda t: t[0].lower())


@router.post("/programs", response_model=ProgramOut, status_code=201)
async def upload_program(file: UploadFile = File(...), db: Session = Depends(get_session)):
    """Upload one program, or a .zip of programs (each stored; the first by name is returned)."""
    name = Path(file.filename or "program.nc").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS and ext != ".zip":
        raise HTTPException(400, f"Unsupported file type '{ext or 'none'}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}, .zip")
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    items = _programs_from_zip(raw, name) if ext == ".zip" else [(name, raw)]
    progs = []
    for fname, data in items:
        text = _check_text(data, fname)
        progs.append(Program(filename=fname, size_bytes=len(data), line_count=text.count("\n") + 1, content=text))
    db.add_all(progs)
    db.commit()
    db.refresh(progs[0])
    return progs[0]


@router.get("/programs", response_model=list[ProgramOut])
def list_programs(db: Session = Depends(get_session)):
    return db.scalars(select(Program).order_by(Program.uploaded_at.desc()).limit(100)).all()


def _get(db: Session, program_id: int) -> Program:
    prog = db.get(Program, program_id)
    if prog is None:
        raise HTTPException(404, "Program not found")
    return prog


@router.get("/programs/{program_id}", response_model=ProgramDetail)
def get_program(program_id: int, db: Session = Depends(get_session)):
    return _get(db, program_id)


@router.delete("/programs/{program_id}", status_code=204)
def delete_program(program_id: int, db: Session = Depends(get_session)):
    db.delete(_get(db, program_id))
    db.commit()


@router.post("/programs/{program_id}/interpret")
def interpret_program(program_id: int, setup: SetupIn, db: Session = Depends(get_session)):
    prog = _get(db, program_id)
    data = setup.model_dump()
    stock = data.pop("stock")
    tools = {k: {kk: vv for kk, vv in v.items() if vv is not None} for k, v in data.pop("tools").items()}
    try:
        settings = InterpreterSettings(**data)
        result = verify(
            prog.content,
            settings,
            StockSetup(tuple(stock["size"]), stock["origin"], stock["top_z"], stock["allowance"], stock["material"]),
            tools,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    prog.last_status = result["summary"]["status"]
    db.commit()
    return {"program": {"id": prog.id, "filename": prog.filename}, **result}
