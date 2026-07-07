import os

settings = {
    "debug": os.environ.get("DEBUG", "0") == "1",
    "db_path": os.environ.get("DB_PATH", "app.db"),
}

_INTERNAL_FLAG = True
