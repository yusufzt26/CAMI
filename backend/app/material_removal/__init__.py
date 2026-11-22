"""Material removal engine (Phase 2).

Z-map stock model for 3-axis milling and drilling. Consumes the interpreter's
motion list plus tool shapes; knows nothing about G-code syntax, fixtures or
machine kinematics (collision checking is a separate engine).
"""

from .simulate import StockResult, StockSetup, simulate, stock_box
from .tools import TOOL_TYPES, ToolSpec, resolve_tools, tool_hints_from_comments
from .zmap import Grid, ZMap

__all__ = [
    "Grid",
    "StockResult",
    "StockSetup",
    "TOOL_TYPES",
    "ToolSpec",
    "ZMap",
    "resolve_tools",
    "simulate",
    "stock_box",
    "tool_hints_from_comments",
]
