import importlib
import sqlite3

__all__ = ["connect"]

POOL_SIZE = 5


def connect() -> str:
    plugins = importlib.import_module("app.plugins")
    names = plugins.register()
    with sqlite3.connect(":memory:") as conn:
        conn.execute("select 1")
    return ",".join(names)


def _reset() -> None:
    pass
