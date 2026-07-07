import requests

from ..db import client
from ..models.user import User


def handle_request(route: str) -> dict:
    if route == "/health":
        return {"ok": True}
    if route == "/whoami":
        user = User(name="anonymous")
        return {"user": user.name, "db": client.connect()}
    return _proxy(route)


def _proxy(route: str) -> dict:
    return requests.get(f"https://upstream.internal{route}").json()
