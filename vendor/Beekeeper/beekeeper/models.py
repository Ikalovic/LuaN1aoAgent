from datetime import datetime
from sqlalchemy import Boolean, Column, Integer, String, DateTime, Index, UniqueConstraint
from sqlalchemy.sql import func

from .database import Base

class Credential(Base):
    __tablename__ = "credentials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    domain = Column(String(255), nullable=False, index=True)
    account = Column(String(512), nullable=False)
    password = Column(String(1024), nullable=False)
    source = Column(String(255), default="")
    is_valid = Column(Boolean, default=True, server_default="1")
    created_at = Column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_credentials_domain_account", "domain", "account"),
        UniqueConstraint("domain", "account", "password", name="uq_credential"),
    )
