"""Tests for beekeeper API endpoints."""
import pytest

API_HEADERS = {"X-API-Key": "test-key-123"}


class TestCreateCredential:
    def test_create_credential(self, client):
        """POST /api/v1/credentials with valid data + API key."""
        resp = client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass123"},
            headers=API_HEADERS,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["domain"] == "example.com"
        assert data["account"] == "admin"
        assert "id" in data

    def test_create_credential_no_api_key(self, client):
        """POST without API key returns 401 (missing header)."""
        resp = client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass123"},
        )
        assert resp.status_code == 422  # missing required header

    def test_create_credential_wrong_api_key(self, client):
        """POST with wrong key returns 401."""
        resp = client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass123"},
            headers={"X-API-Key": "wrong-key"},
        )
        assert resp.status_code == 401

    def test_create_credential_duplicate(self, client):
        """POST same data returns 409."""
        payload = {"domain": "example.com", "account": "admin", "password": "pass123"}
        resp1 = client.post("/api/v1/credentials", json=payload, headers=API_HEADERS)
        assert resp1.status_code == 201

        resp2 = client.post("/api/v1/credentials", json=payload, headers=API_HEADERS)
        assert resp2.status_code == 409


class TestQueryCredentials:
    def test_query_credentials(self, client):
        """GET /api/v1/credentials/{domain}."""
        # Seed data
        client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass1"},
            headers=API_HEADERS,
        )
        client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "root", "password": "pass2"},
            headers=API_HEADERS,
        )

        resp = client.get("/api/v1/credentials/example.com", headers=API_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["domain"] == "example.com"
        assert data["total"] == 2
        assert len(data["results"]) == 2


class TestBulkImport:
    def test_bulk_import(self, client):
        """POST /api/v1/credentials/bulk."""
        records = [
            {"domain": "example.com", "account": "admin", "password": "pass1"},
            {"domain": "example.com", "account": "root", "password": "pass2"},
            {"domain": "other.com", "account": "user", "password": "pass3"},
        ]
        resp = client.post("/api/v1/credentials/bulk", json=records, headers=API_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["imported"] == 3
        assert data["skipped"] == 0


class TestStatistics:
    def test_get_statistics(self, client):
        """GET /api/v1/statistics."""
        # Seed data
        client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass1"},
            headers=API_HEADERS,
        )

        resp = client.get("/api/v1/statistics", headers=API_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_credentials"] >= 1
        assert data["total_domains"] >= 1


class TestDeleteCredential:
    def test_delete_credential(self, client):
        """DELETE /api/v1/credentials/{id}."""
        resp = client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass1"},
            headers=API_HEADERS,
        )
        cred_id = resp.json()["id"]

        resp = client.delete(f"/api/v1/credentials/{cred_id}", headers=API_HEADERS)
        assert resp.status_code == 200

    def test_delete_credential_not_found(self, client):
        """DELETE non-existent returns 404."""
        resp = client.delete("/api/v1/credentials/99999", headers=API_HEADERS)
        assert resp.status_code == 404


class TestDeleteByDomain:
    def test_delete_by_domain(self, client):
        """DELETE /api/v1/credentials/domain/{domain}."""
        client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "admin", "password": "pass1"},
            headers=API_HEADERS,
        )
        client.post(
            "/api/v1/credentials",
            json={"domain": "example.com", "account": "root", "password": "pass2"},
            headers=API_HEADERS,
        )

        resp = client.delete("/api/v1/credentials/domain/example.com", headers=API_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"] == 2
