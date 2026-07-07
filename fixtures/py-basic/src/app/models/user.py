from ..config import settings

USER_TABLE = "users"


class User:
    def __init__(self, name: str) -> None:
        self.name = name
        self.debug = settings["debug"]


def _hash_password(raw: str) -> str:
    return raw[::-1]
