"""MCP tool definitions for Beekeeper credential database."""

import json
from pathlib import Path

from mcp.server.mcpserver.server import MCPServer
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from ..config import settings

# Project root: this file is at <root>/beekeeper/mcp_server/server.py
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _resolve_db_url() -> str:
    """Build a database URL with absolute path, resolved against project root.

    This ensures the MCP server finds the same SQLite file as the web app
    regardless of the caller's CWD.
    """
    url = settings.database_url
    if url.startswith("sqlite:///"):
        rel_path = url.removeprefix("sqlite:///")
        abs_path = _PROJECT_ROOT / rel_path
        return f"sqlite:///{abs_path}"
    return url


def _create_readonly_engine():
    """Create a read-only SQLite engine for MCP queries."""
    engine = create_engine(
        _resolve_db_url(),
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-64000")
        cursor.close()

    return engine


# Create MCPServer instance
mcp = MCPServer(
    "beekeeper",
    description="Credential leak database manager - MCP interface for AI agents",
)


# Preview sample size for query_credentials (always return only a few entries)
_MCP_PREVIEW_LIMIT = 3


@mcp.tool()
def query_credentials(domain: str) -> str:
    """Preview credentials for a specific domain. Returns ONLY the count and first 3 entries as a sample.

    IMPORTANT: Do NOT call this tool repeatedly for each domain — this wastes your context window.
    Instead, use get_database_info() to get the database path, then write a Python script using sqlite3 to query all relevant domains in one operation.
    Or use get_enumeration_script() to get a ready-made script template.
    """
    from ..core import query_by_domain, count_by_domain

    engine = _create_readonly_engine()
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        domain = domain.strip().lower()
        results = query_by_domain(db, domain, limit=_MCP_PREVIEW_LIMIT)
        total = count_by_domain(db, domain)

        response = {
            "domain": domain,
            "total_count": total,
            "preview": [
                {"account": r.account, "password": r.password, "source": r.source}
                for r in results
            ],
            "hint": "This is a PREVIEW only (first 3 entries). For comprehensive enumeration, use get_enumeration_script() to generate a batch query script, or use get_database_info() to get the DB path and query directly with sqlite3.",
        }
        return json.dumps(response, ensure_ascii=False, indent=2)
    finally:
        db.close()
        engine.dispose()


@mcp.tool()
def credential_statistics() -> str:
    """Get statistics about the credential database.
    Returns total credentials count, total domains count, and latest import time."""
    from ..core import get_statistics

    engine = _create_readonly_engine()
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        stats = get_statistics(db)
        if stats.get("latest_import"):
            stats["latest_import"] = stats["latest_import"].isoformat()
        return json.dumps(stats, ensure_ascii=False, indent=2)
    finally:
        db.close()
        engine.dispose()


@mcp.tool()
def get_database_info() -> str:
    """Get database path, schema, and recommended workflow.

    RECOMMENDED WORKFLOW:
    1. Call this tool to get the database path
    2. Write a Python script using sqlite3 to query the database directly
    3. This lets you filter, sort, and process ALL results efficiently without context window limits

    Use get_enumeration_script() for a ready-made script template.
    """
    from pathlib import Path
    db_path = settings.database_url.removeprefix("sqlite:///")
    abs_path = str((_PROJECT_ROOT / db_path).resolve())

    info = {
        "db_path": abs_path,
        "table": "credentials",
        "columns": [
            {
                "name": "id",
                "type": "INTEGER",
                "description": "Auto-increment primary key",
            },
            {
                "name": "domain",
                "type": "VARCHAR(255)",
                "description": "Domain name (lowercase)",
            },
            {
                "name": "account",
                "type": "VARCHAR(512)",
                "description": "Username/account",
            },
            {
                "name": "password",
                "type": "VARCHAR(1024)",
                "description": "Password",
            },
            {
                "name": "source",
                "type": "VARCHAR(255)",
                "description": "Data source (optional)",
            },
            {
                "name": "created_at",
                "type": "TIMESTAMP",
                "description": "Import timestamp",
            },
        ],
        "indexes": [
            "ix_credentials_domain (domain)",
            "ix_credentials_domain_account (domain, account)",
            "uq_credential (domain, account, password) UNIQUE",
        ],
        "recommended_workflow": "Use Python sqlite3 module to query this database directly. This is far more efficient than calling query_credentials repeatedly. Example: import sqlite3; conn = sqlite3.connect(db_path); cursor = conn.execute('SELECT domain, account, password, source FROM credentials WHERE domain LIKE ?', ('%target%',))",
    }
    return json.dumps(info, ensure_ascii=False, indent=2)


@mcp.tool()
def get_enumeration_script(domain_pattern: str = "*") -> str:
    """Generate a Python script for bulk credential enumeration.

    Returns a ready-to-use Python script that queries the database directly.
    This is MUCH more efficient than calling query_credentials multiple times.

    Args:
        domain_pattern: SQL LIKE pattern to filter domains (e.g., "%target-company.com", "%").
                        Use "*" or "%" for all domains. Wildcards: "*" will be converted to "%".
    """
    from pathlib import Path
    db_path_raw = settings.database_url.removeprefix("sqlite:///")
    abs_db_path = str((_PROJECT_ROOT / db_path_raw).resolve())

    # Normalize wildcard style
    sql_pattern = domain_pattern.replace("*", "%")

    script_template = '''#!/usr/bin/env python3
"""Bulk credential enumeration script for target: __DOMAIN_PATTERN__

This script returns ONLY verified valid credentials. Invalid/expired entries are automatically filtered.
"""
import sqlite3
import json

DB_PATH = "__DB_PATH__"

def query_all(pattern):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get all matching credentials (only valid ones)
    cursor = conn.execute(
        "SELECT domain, account, password, source FROM credentials "
        "WHERE domain LIKE ? AND is_valid = 1 "
        "ORDER BY domain, account",
        (pattern.replace("*", "%"),)
    )

    results = {}
    for row in cursor:
        domain = row["domain"]
        if domain not in results:
            results[domain] = []
        results[domain].append({
            "account": row["account"],
            "password": row["password"],
            "source": row["source"],
        })

    conn.close()
    return results

if __name__ == "__main__":
    creds = query_all("__SQL_PATTERN__")

    # Print summary
    total = sum(len(v) for v in creds.values())
    print(f"Found {total} valid credentials across {len(creds)} domains\\n")

    for domain, entries in sorted(creds.items()):
        print(f"\\n=== {domain} ({len(entries)} credentials) ===")
        for e in entries:
            print(f"  {e['account']} : {e['password']}  [{e['source']}]")

    # You can also export as JSON for further processing:
    # with open("credentials.json", "w") as f:
    #     json.dump(creds, f, indent=2)
'''
    script = (
        script_template
        .replace("__DOMAIN_PATTERN__", domain_pattern)
        .replace("__DB_PATH__", abs_db_path)
        .replace("__SQL_PATTERN__", sql_pattern)
    )
    return script
