from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import ipaddress
import re
import socket
import sys
from urllib.parse import urlparse

import httpx


MAX_INPUT_BYTES = 2 << 20
MAX_BODY_BYTES = 1 << 20
CONTEXT_PATH = Path(os.environ.get("LUANNIAO_REPLAY_CONTEXT", "/run/luanniao-replay-pending.json"))
CONTEXT_KEYS = {
    "replayOf",
    "runtimeRef",
    "taskRef",
    "runRef",
    "routeRef",
    "connectionRef",
    "attribution",
}


def read_request() -> dict:
    payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError("replay input exceeds 2 MiB")
    value = json.loads(payload or b"{}")
    if not isinstance(value, dict):
        raise ValueError("replay input must be an object")
    return value


def validate_text(value: object, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(character) < 32 for character in value):
        raise ValueError(f"invalid {name}")
    return value


def validate_header_value(value: object) -> str:
    if not isinstance(value, str) or len(value) > 16 << 10 or any(character in value for character in "\0\r\n"):
        raise ValueError("invalid header value")
    return value


def validate_context(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - CONTEXT_KEYS:
        raise ValueError("invalid replay context")
    context = {}
    for key, item in value.items():
        if item in (None, ""):
            continue
        context[key] = validate_text(item, key, 1024 if key == "replayOf" else 512)
    if "replayOf" not in context:
        raise ValueError("replay context has no replayOf")
    return context


def validate_headers(value: object) -> list[tuple[str, str]]:
    if not isinstance(value, list) or len(value) > 512:
        raise ValueError("invalid replay headers")
    headers = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"name", "value"}:
            raise ValueError("invalid replay header")
        name = validate_text(item["name"], "header name", 256)
        header_value = validate_header_value(item["value"])
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
            raise ValueError("invalid replay header name")
        headers.append((name, header_value))
    return headers


def replay(value: dict) -> dict:
    if set(value) - {"method", "url", "headers", "body", "context", "targetCidrs"}:
        raise ValueError("unsupported replay input field")
    method = validate_text(value.get("method"), "method", 32)
    if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", method):
        raise ValueError("invalid method")
    url = validate_text(value.get("url"), "url", 8192)
    headers = validate_headers(value.get("headers", []))
    context = validate_context(value.get("context"))
    validate_route_target(url, value.get("targetCidrs", []))
    body = None
    if value.get("body") is not None:
        encoded = validate_text(value["body"], "body", (MAX_BODY_BYTES * 4 // 3) + 8)
        body = base64.b64decode(encoded, validate=True)
        if len(body) > MAX_BODY_BYTES:
            raise ValueError("replay body exceeds 1 MiB")

    descriptor = os.open(CONTEXT_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(context, output, separators=(",", ":"))
        with httpx.Client(verify=False, timeout=30.0, follow_redirects=False, trust_env=False) as client:
            with client.stream(method, url, headers=headers, content=body) as response:
                for _ in response.iter_bytes():
                    pass
                return {"status": response.status_code}
    finally:
        try:
            CONTEXT_PATH.unlink()
        except OSError:
            pass


def validate_route_target(url: str, value: object) -> None:
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError("invalid targetCidrs")
    if not value:
        return
    networks = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("invalid targetCidrs")
        networks.append(ipaddress.ip_network(item, strict=False))
    host = urlparse(url).hostname
    if not host:
        raise ValueError("replay URL has no host")
    try:
        addresses = {
            ipaddress.ip_address(item[4][0])
            for item in socket.getaddrinfo(host, None, socket.AF_INET)
        }
    except socket.gaierror as error:
        raise ValueError("replay route target cannot be resolved") from error
    if not addresses or not all(any(address in network for network in networks) for address in addresses):
        raise ValueError("replay target is outside the original route")


def main() -> None:
    try:
        print(json.dumps({"ok": True, **replay(read_request())}, separators=(",", ":")), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
