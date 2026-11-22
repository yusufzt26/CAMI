from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Vec3 = list[float]


def _default_offsets():
    return {c: [0.0, 0.0, 0.0] for c in ("G54", "G55", "G56", "G57", "G58", "G59")}


class StockIn(BaseModel):
    size: Vec3 = Field(default_factory=lambda: [200.0, 150.0, 40.0])
    origin: Literal["top-center", "top-front-left", "top-front-right", "top-back-left", "top-back-right"] = "top-center"
    top_z: float = 0.0
    allowance: float = Field(0.0, ge=0)
    material: str = "P20 mould steel"


class ToolIn(BaseModel):
    type: Literal["flat", "ball", "bull", "face", "drill", "spot", "reamer", "tap", "counterbore"] = "flat"
    diameter: float = Field(10.0, gt=0)
    corner_radius: float = Field(0.0, ge=0)
    point_angle: float | None = None


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
    cutter_comp_mode: Literal["tool_radius", "zero"] = "tool_radius"
    stock: StockIn = Field(default_factory=StockIn)
    tools: dict[str, ToolIn] = Field(default_factory=dict)


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
