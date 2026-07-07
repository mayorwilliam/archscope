"""Entry point: absolute imports resolved through the src/ layout root."""

import json

from app.api.handlers import handle_request


def run() -> None:
    print(json.dumps(handle_request("/health")))


if __name__ == "__main__":
    run()
