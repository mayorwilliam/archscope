"""Loaded only via importlib.import_module — a dynamic-import edge target."""


def register() -> list[str]:
    return ["audit", "metrics"]
