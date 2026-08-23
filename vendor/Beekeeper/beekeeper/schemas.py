from datetime import datetime
from pydantic import BaseModel, Field, field_validator

class CredentialInput(BaseModel):
    domain: str = Field(..., min_length=1, max_length=255, pattern=r'^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$')
    account: str = Field(..., min_length=1, max_length=512)
    password: str = Field(..., min_length=1, max_length=1024)
    source: str = Field(default="", max_length=255)

    @field_validator('domain', 'account', 'password')
    @classmethod
    def no_control_chars(cls, v: str) -> str:
        if any(ord(c) < 32 for c in v):
            raise ValueError('Contains control characters')
        return v.strip()

    @field_validator('domain')
    @classmethod
    def normalize_domain(cls, v: str) -> str:
        return v.strip().lower()

class CredentialResponse(BaseModel):
    id: int
    domain: str
    account: str
    created_at: datetime | None = None

    model_config = {"from_attributes": True}

class CredentialPair(BaseModel):
    account: str
    password: str

class CredentialQueryResponse(BaseModel):
    domain: str
    total: int
    results: list[CredentialPair]

class BulkImportResponse(BaseModel):
    imported: int
    skipped: int
    errors: list[str]

class StatisticsResponse(BaseModel):
    total_credentials: int
    total_domains: int
    latest_import: datetime | None = None
