"""Controller dialect definitions.

A dialect describes *what codes a controller understands and how they are
classified*. The interpreter consults the dialect for every code it meets, so
adding Siemens or Mitsubishi support means adding a new dialect (and, where the
semantics differ, dialect-specific handlers) without touching the lexer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Support(str, Enum):
    SUPPORTED = "supported"  # fully interpreted
    NO_EFFECT = "no_effect"  # recognised, has no geometric effect on the toolpath (info)
    LIMITED = "limited"  # recognised, interpreted with a stated approximation (warning)
    UNSUPPORTED = "unsupported"  # recognised but not interpreted: verification must stop


@dataclass(frozen=True)
class CodeSpec:
    code: str
    group: str  # modal group name; codes in the same group conflict within a block
    description: str
    support: Support
    note: str = ""


@dataclass
class ControllerDialect:
    key: str
    name: str
    g_codes: dict[str, CodeSpec] = field(default_factory=dict)
    m_codes: dict[str, CodeSpec] = field(default_factory=dict)
    # Address letters allowed on a 3-axis machine and what they mean.
    letters: dict[str, str] = field(default_factory=dict)
    # Address letters that indicate axes this machine does not have.
    foreign_axes: set[str] = field(default_factory=set)
    # Peck-drilling retract/clearance amount (FANUC parameter 5114/5115), mm.
    peck_clearance_mm: float = 0.5

    def lookup(self, code: str) -> CodeSpec | None:
        table = self.g_codes if code.startswith("G") else self.m_codes
        return table.get(code)

    def describe(self) -> dict:
        def rows(table: dict[str, CodeSpec]):
            return [
                {
                    "code": s.code,
                    "group": s.group,
                    "description": s.description,
                    "support": s.support.value,
                    "note": s.note,
                }
                for s in table.values()
            ]

        return {"key": self.key, "name": self.name, "g_codes": rows(self.g_codes), "m_codes": rows(self.m_codes)}
