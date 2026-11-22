from .base import CodeSpec, ControllerDialect, Support
from .fanuc import build_fanuc

_REGISTRY = {
    "fanuc": build_fanuc,
    # "siemens": build_siemens,       # planned
    # "mitsubishi": build_mitsubishi, # planned
}


def get_dialect(key: str) -> ControllerDialect:
    try:
        return _REGISTRY[key]()
    except KeyError as exc:
        raise ValueError(f"Unknown controller '{key}'. Available: {', '.join(_REGISTRY)}") from exc


def available_dialects() -> list[dict]:
    return [{"key": k, "name": f().name} for k, f in _REGISTRY.items()]


__all__ = ["CodeSpec", "ControllerDialect", "Support", "get_dialect", "available_dialects"]
