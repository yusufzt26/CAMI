from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Vec3 = list[float]


def _default_offsets():
    return {c: [0.0, 0.0, 0.0] for c in ("G54", "G55", "G56", "G57", "G58", "G59")}


class SetupIn(BaseModel):
    controller: str = "fanuc"
    initial_units: Literal["mm", "inch"] = "mm"
    work_offsets: dict[str, Vec3] = Field(default_factory=_default_offsets)
    reference_position: Vec3 = Field(default_factory=lambda: [0.0, 0.0, 100.0])
    rapid_rate: float = Field(15000.0, gt=0)
    max_feed: float = Field(10000.0, gt=0)
    tool_change_time: float = Field(6.0, ge=0)
    decimal_mode: Literal["calculator", "least_increment"] = "calculator"
    rapid_mode: Literal["linear", "dogleg"] = "linear"
    block_delete_switch: bool = False


class ProgramOut(BaseModel):
    id: int
    filename: str
    controller: str
    size_bytes: int
    line_count: int
    uploaded_at: datetime
    last_status: str | None = None


class ProgramDetail(ProgramOut):
    content: str
