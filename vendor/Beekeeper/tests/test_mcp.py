"""Tests for beekeeper MCP tools."""
import json
import os
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from beekeeper.database import Base
from beekeeper.config import Settings
from beekeeper.core import store_credential


@pytest.fixture
def mcp_env(db_session, monkeypatch, tmp_path):
    """Set up MCP tools to use the same temp DB as db_session.

    The MCP tools create their own engine via _resolve_db_url() which reads
    settings.database_url. We need to point that at the temp db file.
    """
    # We need the path to the temp db used by db_session.
    # db_session's engine has the URL; extract it.
    db_url = db_session.get_bind().url
    db_path = str(db_url).removeprefix("sqlite:///")

    # Build a settings object whose database_url points to the same file
    mcp_settings = Settings(database_url=f"sqlite:///{db_path}", api_key="test-key-123")

    # Patch the settings reference used by mcp server module
    monkeypatch.setattr("beekeeper.mcp_server.server.settings", mcp_settings)

    return db_session


class TestQueryCredentials:
    def test_query_credentials(self, mcp_env):
        """Call the tool function, verify preview-only results."""
        from beekeeper.mcp_server.server import query_credentials

        # Seed data
        for i in range(15):
            store_credential(mcp_env, "example.com", f"user{i}", f"pass{i}")

        result = json.loads(query_credentials("example.com"))
        assert result["domain"] == "example.com"
        assert result["total_count"] == 15
        # Preview is limited to 3 entries
        assert len(result["preview"]) == 3
        # Each preview entry includes source field
        assert "source" in result["preview"][0]
        assert "hint" in result

    def test_query_credentials_empty(self, mcp_env):
        """Query a domain with no data."""
        from beekeeper.mcp_server.server import query_credentials

        result = json.loads(query_credentials("nonexistent.com"))
        assert result["domain"] == "nonexistent.com"
        assert result["total_count"] == 0
        assert result["preview"] == []


class TestCredentialStatistics:
    def test_credential_statistics(self, mcp_env):
        """Call the tool, verify stats returned."""
        from beekeeper.mcp_server.server import credential_statistics

        store_credential(mcp_env, "example.com", "admin", "pass1")
        store_credential(mcp_env, "other.com", "user", "pass2")

        result = json.loads(credential_statistics())
        assert result["total_credentials"] == 2
        assert result["total_domains"] == 2
        assert result["latest_import"] is not None


class TestGetDatabaseInfo:
    def test_get_database_info(self, mcp_env):
        """Call the tool, verify path and schema info."""
        from beekeeper.mcp_server.server import get_database_info

        result = json.loads(get_database_info())
        assert "db_path" in result
        assert result["table"] == "credentials"
        assert "columns" in result
        assert len(result["columns"]) == 6
        column_names = [c["name"] for c in result["columns"]]
        assert "id" in column_names
        assert "domain" in column_names
        assert "account" in column_names
        assert "password" in column_names
        assert "indexes" in result
        assert "recommended_workflow" in result


class TestGetEnumerationScript:
    def test_get_enumeration_script_default(self, mcp_env):
        """Generate script with default pattern."""
        from beekeeper.mcp_server.server import get_enumeration_script

        script = get_enumeration_script()
        assert "#!/usr/bin/env python3" in script
        assert "import sqlite3" in script
        assert "DB_PATH" in script
        assert 'query_all("%")' in script

    def test_get_enumeration_script_with_pattern(self, mcp_env):
        """Generate script with specific domain pattern."""
        from beekeeper.mcp_server.server import get_enumeration_script

        script = get_enumeration_script("%target.com")
        assert "target.com" in script
        assert 'query_all("%target.com")' in script

    def test_get_enumeration_script_star_to_percent(self, mcp_env):
        """Verify * wildcards are converted to %."""
        from beekeeper.mcp_server.server import get_enumeration_script

        script = get_enumeration_script("*")
        assert 'query_all("%")' in script
