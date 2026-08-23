#!/usr/bin/env python3
"""Project-local Beekeeper MCP adapter for LuaN1aoAgent."""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path
from typing import Any


def _bootstrap() -> Path:
    default_root = Path(__file__).resolve().parent.parent / "vendor" / "Beekeeper"
    root = Path(os.environ.get("BEEKEEPER_ROOT", str(default_root))).resolve()
    sys.path.insert(0, str(root))
    os.chdir(root)
    database_url = os.environ.get("BEEKEEPER_DATABASE_URL", "sqlite:///data/beekeeper.db")
    if database_url.startswith("sqlite:///") and not database_url.startswith("sqlite:////"):
        database_url = f"sqlite:///{(root / database_url.removeprefix('sqlite:///')).resolve()}"
        os.environ["BEEKEEPER_DATABASE_URL"] = database_url
    return root


_bootstrap()

from beekeeper.core import store_credential as beekeeper_store_credential  # noqa: E402
from beekeeper.database import Base, SessionLocal, engine  # noqa: E402
from beekeeper.models import Credential  # noqa: E402


MAX_PAGE_SIZE = int(os.environ.get("BEEKEEPER_MCP_MAX_PAGE_SIZE", "50") or "50")
if MAX_PAGE_SIZE <= 0:
    MAX_PAGE_SIZE = 50


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _clean_text(value: str, name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{name} must be a non-empty string")
    return cleaned


def _normalize_domain(domain: str | None) -> str | None:
    if domain is None:
        return None
    return _clean_text(domain, "domain").lower()


def _limit(value: int | None) -> int:
    if value is None:
        return MAX_PAGE_SIZE
    if not isinstance(value, int) or value <= 0:
        raise ValueError("limit must be a positive integer")
    return min(value, MAX_PAGE_SIZE)


def _encode_cursor(domain: str | None, include_invalid: bool, last_id: int) -> str:
    raw = json.dumps(
        {"v": 1, "domain": domain, "include_invalid": include_invalid, "last_id": last_id},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str, domain: str | None, include_invalid: bool) -> int:
    try:
        padded = cursor + ("=" * (-len(cursor) % 4))
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except Exception as exc:
        raise ValueError("cursor is invalid") from exc
    if (
        payload.get("v") != 1
        or payload.get("domain") != domain
        or payload.get("include_invalid") != include_invalid
    ):
        raise ValueError("cursor does not match this query")
    last_id = payload.get("last_id")
    if not isinstance(last_id, int) or last_id < 0:
        raise ValueError("cursor is invalid")
    return last_id


def _credential_payload(credential: Credential) -> dict[str, Any]:
    created_at = credential.created_at.isoformat() if credential.created_at else None
    return {
        "id": credential.id,
        "domain": credential.domain,
        "account": credential.account,
        "password": credential.password,
        "source": credential.source or "",
        "is_valid": bool(credential.is_valid),
        "created_at": created_at,
    }


def query_credentials(
    domain: str | None = None,
    cursor: str | None = None,
    limit: int | None = None,
    include_invalid: bool = False,
) -> str:
    """Query plaintext credentials with keyset pagination.

    Omit domain to query across all domains. Use next_cursor to continue only if
    more data is useful; stop after finding a credential that validates.
    """
    normalized_domain = _normalize_domain(domain)
    page_size = _limit(limit)
    last_id = _decode_cursor(cursor, normalized_domain, include_invalid) if cursor else 0
    db = SessionLocal()
    try:
        query = db.query(Credential).filter(Credential.id > last_id)
        if normalized_domain is not None:
            query = query.filter(Credential.domain == normalized_domain)
        if not include_invalid:
            query = query.filter(Credential.is_valid == True)
        rows = query.order_by(Credential.id.asc()).limit(page_size + 1).all()
        items = rows[:page_size]
        has_more = len(rows) > page_size
        next_cursor = _encode_cursor(normalized_domain, include_invalid, items[-1].id) if has_more and items else None
        return _json({
            "domain": normalized_domain,
            "include_invalid": include_invalid,
            "limit": page_size,
            "total_returned": len(items),
            "has_more": has_more,
            "next_cursor": next_cursor,
            "items": [_credential_payload(row) for row in items],
        })
    finally:
        db.close()


def store_credential(domain: str, account: str, password: str, source: str = "") -> str:
    """Store a credential. New rows are valid by default."""
    normalized_domain = _normalize_domain(domain)
    account = _clean_text(account, "account")
    password = _clean_text(password, "password")
    source = source.strip() if source else ""
    db = SessionLocal()
    try:
        created = beekeeper_store_credential(db, normalized_domain, account, password, source)
        if created is not None:
            return _json({
                "status": "created",
                "credential_id": created.id,
                "domain": created.domain,
                "is_valid": bool(created.is_valid),
            })
        existing = (
            db.query(Credential)
            .filter(
                Credential.domain == normalized_domain,
                Credential.account == account,
                Credential.password == password,
            )
            .first()
        )
        if existing is None:
            raise ValueError("duplicate credential could not be resolved")
        return _json({
            "status": "already_exists",
            "credential_id": existing.id,
            "domain": existing.domain,
            "is_valid": bool(existing.is_valid),
        })
    finally:
        db.close()


def mark_credential_invalid(credential_id: int, reason: str | None = None) -> str:
    """Mark one credential invalid after explicit authentication rejection."""
    if not isinstance(credential_id, int) or credential_id <= 0:
        raise ValueError("credential_id must be a positive integer")
    db = SessionLocal()
    try:
        credential = db.query(Credential).filter(Credential.id == credential_id).first()
        if credential is None:
            return _json({"status": "not_found", "credential_id": credential_id})
        was_valid = bool(credential.is_valid)
        if was_valid:
            credential.is_valid = False
            db.commit()
        return _json({
            "status": "invalidated" if was_valid else "already_invalid",
            "credential_id": credential_id,
            "is_valid": False,
            "reason": reason,
        })
    finally:
        db.close()


TOOLS = {
    "query_credentials": query_credentials,
    "store_credential": store_credential,
    "mark_credential_invalid": mark_credential_invalid,
}


def _tool_schema(name: str) -> dict[str, Any]:
    schemas: dict[str, dict[str, Any]] = {
        "query_credentials": {
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "cursor": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1},
                "include_invalid": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
        "store_credential": {
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "account": {"type": "string"},
                "password": {"type": "string"},
                "source": {"type": "string"},
            },
            "required": ["domain", "account", "password"],
            "additionalProperties": False,
        },
        "mark_credential_invalid": {
            "type": "object",
            "properties": {
                "credential_id": {"type": "integer", "minimum": 1},
                "reason": {"type": "string"},
            },
            "required": ["credential_id"],
            "additionalProperties": False,
        },
    }
    descriptions = {
        "query_credentials": "Query plaintext Beekeeper credentials with bounded keyset pagination.",
        "store_credential": "Store one Beekeeper credential. New credentials are valid by default.",
        "mark_credential_invalid": "Mark one credential invalid after explicit authentication rejection.",
    }
    return {
        "name": name,
        "description": descriptions[name],
        "inputSchema": schemas[name],
    }


def _success(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def _error(message_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def _tool_result(text: str, is_error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def _handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    message_id = message.get("id")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        requested_version = params.get("protocolVersion")
        protocol_version = requested_version if isinstance(requested_version, str) else "2025-11-25"
        return _success(message_id, {
            "protocolVersion": protocol_version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "luanniao-beekeeper", "version": "1.0.0"},
        })
    if method == "tools/list":
        return _success(message_id, {"tools": [_tool_schema(name) for name in sorted(TOOLS)]})
    if method == "tools/call":
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        name = params.get("name")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if not isinstance(name, str) or name not in TOOLS:
            return _error(message_id, -32601, "Unknown tool")
        try:
            return _success(message_id, _tool_result(TOOLS[name](**args)))
        except Exception as exc:
            return _success(message_id, _tool_result(str(exc), True))
    if message_id is None:
        return None
    return _error(message_id, -32601, "Method not found")


def main() -> None:
    Base.metadata.create_all(bind=engine)
    for line in sys.stdin:
        try:
            message = json.loads(line)
            response = _handle(message)
        except Exception as exc:
            response = _error(None, -32700, str(exc))
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
