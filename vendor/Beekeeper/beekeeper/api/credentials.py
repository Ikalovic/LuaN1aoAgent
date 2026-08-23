from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import (
    CredentialInput,
    CredentialResponse,
    CredentialPair,
    CredentialQueryResponse,
    BulkImportResponse,
    StatisticsResponse,
)
from .. import core
from .deps import verify_api_key

router = APIRouter(prefix="/api/v1", tags=["credentials"])


@router.post("/credentials", status_code=201, response_model=CredentialResponse)
def create_credential(
    body: CredentialInput,
    db: Session = Depends(get_db),
    _=Depends(verify_api_key),
):
    """Store a single credential."""
    cred = core.store_credential(
        db,
        domain=body.domain,
        account=body.account,
        password=body.password,
        source=body.source,
    )
    if cred is None:
        raise HTTPException(status_code=409, detail="Credential already exists")
    return cred


@router.post("/credentials/bulk", response_model=BulkImportResponse)
def bulk_import_credentials(
    records: list[CredentialInput],
    db: Session = Depends(get_db),
    _=Depends(verify_api_key),
):
    """Bulk import credentials."""
    result = core.bulk_import(db, [r.model_dump() for r in records])
    return BulkImportResponse(**result)


@router.get("/credentials/{domain}", response_model=CredentialQueryResponse)
def query_credentials(
    domain: str,
    limit: int = Query(default=100, ge=1, le=10000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _=Depends(verify_api_key),
):
    """Query credentials by domain."""
    creds = core.query_by_domain(db, domain, limit=limit, offset=offset)
    total = core.count_by_domain(db, domain)
    return CredentialQueryResponse(
        domain=domain.strip().lower(),
        total=total,
        results=[CredentialPair(account=c.account, password=c.password) for c in creds],
    )


@router.get("/statistics", response_model=StatisticsResponse)
def get_statistics(
    db: Session = Depends(get_db),
    _=Depends(verify_api_key),
):
    """Get database statistics."""
    stats = core.get_statistics(db)
    return StatisticsResponse(**stats)


@router.delete("/credentials/{credential_id}")
def delete_credential(
    credential_id: int,
    db: Session = Depends(get_db),
    _=Depends(verify_api_key),
):
    """Delete a credential by ID."""
    if not core.delete_credential(db, credential_id):
        raise HTTPException(status_code=404, detail="Credential not found")
    return {"deleted": True}


@router.delete("/credentials/domain/{domain}")
def delete_by_domain(
    domain: str,
    db: Session = Depends(get_db),
    _=Depends(verify_api_key),
):
    """Delete all credentials for a domain."""
    count = core.delete_by_domain(db, domain)
    return {"deleted": count}
