from sqlalchemy import func, distinct
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Credential

def store_credential(db: Session, domain: str, account: str, password: str, source: str = "") -> Credential | None:
    """Store a credential. Domain is normalized to lowercase.
    Returns the new Credential or None if duplicate."""
    domain = domain.strip().lower()
    cred = Credential(domain=domain, account=account, password=password, source=source)
    try:
        db.add(cred)
        db.commit()
        db.refresh(cred)
        return cred
    except IntegrityError:
        db.rollback()
        return None

def query_by_domain(db: Session, domain: str, limit: int = 100, offset: int = 0) -> list[Credential]:
    domain = domain.strip().lower()
    return (
        db.query(Credential)
        .filter(Credential.domain == domain)
        .offset(offset)
        .limit(limit)
        .all()
    )

def count_by_domain(db: Session, domain: str) -> int:
    domain = domain.strip().lower()
    return db.query(Credential).filter(Credential.domain == domain).count()

def query_valid_by_domain(db: Session, domain: str, limit: int = 100, offset: int = 0) -> list[Credential]:
    """Query only valid credentials by domain."""
    domain = domain.strip().lower()
    return (
        db.query(Credential)
        .filter(Credential.domain == domain, Credential.is_valid == True)
        .offset(offset)
        .limit(limit)
        .all()
    )

def count_valid_by_domain(db: Session, domain: str) -> int:
    """Count only valid credentials for a domain."""
    domain = domain.strip().lower()
    return db.query(Credential).filter(Credential.domain == domain, Credential.is_valid == True).count()

def get_statistics(db: Session) -> dict:
    total = db.query(Credential).count()
    domains = db.query(distinct(Credential.domain)).count()
    latest = db.query(func.max(Credential.created_at)).scalar()
    return {
        "total_credentials": total,
        "total_domains": domains,
        "latest_import": latest,
    }

def delete_credential(db: Session, credential_id: int) -> bool:
    cred = db.query(Credential).filter(Credential.id == credential_id).first()
    if cred is None:
        return False
    db.delete(cred)
    db.commit()
    return True

def delete_by_domain(db: Session, domain: str) -> int:
    domain = domain.strip().lower()
    count = db.query(Credential).filter(Credential.domain == domain).delete()
    db.commit()
    return count

def bulk_import(db: Session, records: list[dict], batch_size: int = 1000) -> dict:
    imported = 0
    skipped = 0
    errors: list[str] = []

    for i, record in enumerate(records):
        try:
            result = store_credential(
                db,
                domain=record["domain"],
                account=record["account"],
                password=record["password"],
                source=record.get("source", ""),
            )
            if result is None:
                skipped += 1
            else:
                imported += 1
        except Exception as e:
            errors.append(f"Row {i}: {str(e)}")
            db.rollback()

    return {"imported": imported, "skipped": skipped, "errors": errors}
