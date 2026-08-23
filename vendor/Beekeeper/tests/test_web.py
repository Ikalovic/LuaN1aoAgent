"""Tests for beekeeper WebUI routes."""
import pytest

from beekeeper.core import store_credential


class TestDashboard:
    def test_dashboard(self, client):
        """GET / returns 200."""
        resp = client.get("/")
        assert resp.status_code == 200
        assert "Beekeeper" in resp.text or "credential" in resp.text.lower()


class TestBrowse:
    def test_browse(self, client):
        """GET /browse returns 200."""
        resp = client.get("/browse")
        assert resp.status_code == 200

    def test_browse_search(self, client, db_session):
        """GET /browse/search?q=test returns results."""
        store_credential(db_session, "test.com", "admin", "pass1")

        resp = client.get("/browse/search?q=test")
        assert resp.status_code == 200
        assert "test.com" in resp.text


class TestDomainDetail:
    def test_domain_detail(self, client, db_session):
        """GET /domain/example.com returns 200."""
        store_credential(db_session, "example.com", "admin", "pass1")

        resp = client.get("/domain/example.com")
        assert resp.status_code == 200
        assert "example.com" in resp.text


class TestManagePage:
    def test_manage_page(self, client):
        """GET /manage returns 200."""
        resp = client.get("/manage")
        assert resp.status_code == 200


class TestExportCSV:
    def test_export_csv(self, client, db_session):
        """GET /domain/example.com/export returns CSV."""
        store_credential(db_session, "example.com", "admin", "pass1")
        store_credential(db_session, "example.com", "root", "pass2")

        resp = client.get("/domain/example.com/export")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        content = resp.text
        assert "account" in content  # header row
        assert "admin" in content
        assert "root" in content

    def test_export_csv_empty(self, client):
        """Export for a domain with no data returns empty CSV (just headers)."""
        resp = client.get("/domain/empty.com/export")
        assert resp.status_code == 200
        assert "account" in resp.text  # header row still present
