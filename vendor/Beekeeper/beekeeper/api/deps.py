import secrets
from fastapi import Header, HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal, get_db  # noqa: F401 – re-exported for convenience


async def verify_api_key(x_api_key: str = Header(...)):
    """Verify the API key from X-API-Key header."""
    if not secrets.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")


def get_db_session() -> Session:
    """Non-generator db session for non-FastAPI contexts."""
    return SessionLocal()
