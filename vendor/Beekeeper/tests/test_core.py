"""Tests for beekeeper.core business logic."""
import pytest

from beekeeper.core import (
    store_credential,
    query_by_domain,
    count_by_domain,
    get_statistics,
    delete_credential,
    delete_by_domain,
    bulk_import,
)


class TestStoreCredential:
    def test_store_credential(self, db_session):
        """Store a credential and verify it's in the DB."""
        cred = store_credential(db_session, "example.com", "admin", "pass123", "test")
        assert cred is not None
        assert cred.id is not None
        assert cred.domain == "example.com"
        assert cred.account == "admin"
        assert cred.password == "pass123"
        assert cred.source == "test"

    def test_store_credential_duplicate(self, db_session):
        """Store same credential twice — second returns None."""
        store_credential(db_session, "example.com", "admin", "pass123")
        dup = store_credential(db_session, "example.com", "admin", "pass123")
        assert dup is None

    def test_store_credential_domain_normalization(self, db_session):
        """Domain is normalized to lowercase."""
        cred = store_credential(db_session, "EXAMPLE.COM", "admin", "pass123")
        assert cred is not None
        assert cred.domain == "example.com"

    def test_store_credential_domain_strip(self, db_session):
        """Domain is stripped of whitespace."""
        cred = store_credential(db_session, "  example.com  ", "admin", "pass123")
        assert cred is not None
        assert cred.domain == "example.com"


class TestQueryByDomain:
    def test_query_by_domain(self, db_session):
        """Store multiple credentials, query by domain."""
        store_credential(db_session, "example.com", "admin", "pass1")
        store_credential(db_session, "example.com", "root", "pass2")
        store_credential(db_session, "other.com", "user", "pass3")

        results = query_by_domain(db_session, "example.com")
        assert len(results) == 2
        accounts = {r.account for r in results}
        assert accounts == {"admin", "root"}

    def test_query_by_domain_pagination(self, db_session):
        """Test limit/offset pagination."""
        for i in range(5):
            store_credential(db_session, "example.com", f"user{i}", f"pass{i}")

        page1 = query_by_domain(db_session, "example.com", limit=2, offset=0)
        page2 = query_by_domain(db_session, "example.com", limit=2, offset=2)
        page3 = query_by_domain(db_session, "example.com", limit=2, offset=4)

        assert len(page1) == 2
        assert len(page2) == 2
        assert len(page3) == 1

    def test_query_by_domain_empty(self, db_session):
        """Query a domain with no credentials."""
        results = query_by_domain(db_session, "nonexistent.com")
        assert results == []


class TestCountByDomain:
    def test_count_by_domain(self, db_session):
        """Verify count."""
        store_credential(db_session, "example.com", "admin", "pass1")
        store_credential(db_session, "example.com", "root", "pass2")
        store_credential(db_session, "other.com", "user", "pass3")

        assert count_by_domain(db_session, "example.com") == 2
        assert count_by_domain(db_session, "other.com") == 1
        assert count_by_domain(db_session, "nonexistent.com") == 0


class TestGetStatistics:
    def test_get_statistics_empty(self, db_session):
        """Statistics on empty DB."""
        stats = get_statistics(db_session)
        assert stats["total_credentials"] == 0
        assert stats["total_domains"] == 0
        assert stats["latest_import"] is None

    def test_get_statistics(self, db_session):
        """Verify statistics after adding credentials."""
        store_credential(db_session, "example.com", "admin", "pass1")
        store_credential(db_session, "example.com", "root", "pass2")
        store_credential(db_session, "other.com", "user", "pass3")

        stats = get_statistics(db_session)
        assert stats["total_credentials"] == 3
        assert stats["total_domains"] == 2
        assert stats["latest_import"] is not None


class TestDeleteCredential:
    def test_delete_credential(self, db_session):
        """Delete by ID."""
        cred = store_credential(db_session, "example.com", "admin", "pass1")
        assert delete_credential(db_session, cred.id) is True
        assert count_by_domain(db_session, "example.com") == 0

    def test_delete_credential_not_found(self, db_session):
        """Delete non-existent returns False."""
        assert delete_credential(db_session, 9999) is False


class TestDeleteByDomain:
    def test_delete_by_domain(self, db_session):
        """Delete all for a domain."""
        store_credential(db_session, "example.com", "admin", "pass1")
        store_credential(db_session, "example.com", "root", "pass2")
        store_credential(db_session, "other.com", "user", "pass3")

        count = delete_by_domain(db_session, "example.com")
        assert count == 2
        assert count_by_domain(db_session, "example.com") == 0
        assert count_by_domain(db_session, "other.com") == 1


class TestBulkImport:
    def test_bulk_import(self, db_session):
        """Import multiple records, check imported/skipped counts."""
        records = [
            {"domain": "example.com", "account": "admin", "password": "pass1"},
            {"domain": "example.com", "account": "root", "password": "pass2"},
            {"domain": "other.com", "account": "user", "password": "pass3"},
        ]
        result = bulk_import(db_session, records)
        assert result["imported"] == 3
        assert result["skipped"] == 0
        assert result["errors"] == []

    def test_bulk_import_with_duplicates(self, db_session):
        """Import with some duplicates."""
        store_credential(db_session, "example.com", "admin", "pass1")

        records = [
            {"domain": "example.com", "account": "admin", "password": "pass1"},  # dup
            {"domain": "example.com", "account": "root", "password": "pass2"},   # new
        ]
        result = bulk_import(db_session, records)
        assert result["imported"] == 1
        assert result["skipped"] == 1
