import pytest
from pathlib import Path
import tempfile
import os

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from beekeeper.database import Base
from beekeeper.config import Settings


@pytest.fixture
def db_session():
    """Create a temporary database for testing."""
    # Create temp file
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def set_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()

    yield session

    session.close()
    engine.dispose()
    Path(db_path).unlink(missing_ok=True)


@pytest.fixture
def test_settings():
    """Override settings for testing."""
    return Settings(api_key="test-key-123")


@pytest.fixture
def client(db_session, test_settings, monkeypatch):
    """Create a test client for the FastAPI app."""
    from fastapi.testclient import TestClient

    # Monkeypatch settings
    monkeypatch.setattr("beekeeper.config.settings", test_settings)
    monkeypatch.setattr("beekeeper.api.deps.settings", test_settings)

    # Override the get_db dependency
    from beekeeper.database import get_db
    from beekeeper.main import app

    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c

    app.dependency_overrides.clear()
