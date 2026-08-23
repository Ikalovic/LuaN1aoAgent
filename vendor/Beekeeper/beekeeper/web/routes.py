"""WebUI routes for Beekeeper — human-facing pages (no API key auth)."""
from fastapi import APIRouter, Depends, Form, Request, Query, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from sqlalchemy.orm import Session
from pathlib import Path
import csv
import io

from ..database import get_db
from ..schemas import CredentialInput
from .. import core

router = APIRouter(tags=["web"])
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


@router.get("/", response_class=HTMLResponse)
def dashboard(request: Request, db: Session = Depends(get_db)):
    """Dashboard with statistics overview."""
    stats = core.get_statistics(db)
    return templates.TemplateResponse(request, "dashboard.html", {
        "stats": stats,
    })


@router.get("/browse", response_class=HTMLResponse)
def browse(
    request: Request,
    q: str = Query(default="", description="Search domain"),
    page: int = Query(default=1, ge=1),
    db: Session = Depends(get_db),
):
    """Browse credentials with search and pagination."""
    page_size = 20
    from ..models import Credential
    from sqlalchemy import distinct, func

    if q.strip():
        domains_data = (
            db.query(Credential.domain, func.count(Credential.id).label("count"))
            .filter(Credential.domain.contains(q.strip().lower()))
            .group_by(Credential.domain)
            .order_by(func.count(Credential.id).desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        total_domains = (
            db.query(distinct(Credential.domain))
            .filter(Credential.domain.contains(q.strip().lower()))
            .count()
        )
    else:
        domains_data = (
            db.query(Credential.domain, func.count(Credential.id).label("count"))
            .group_by(Credential.domain)
            .order_by(func.count(Credential.id).desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        total_domains = db.query(distinct(Credential.domain)).count()

    total_pages = max(1, (total_domains + page_size - 1) // page_size)

    return templates.TemplateResponse(request, "browse.html", {
        "domains": domains_data,
        "query": q,
        "page": page,
        "total_pages": total_pages,
    })


@router.get("/browse/search", response_class=HTMLResponse)
def browse_search(
    request: Request,
    q: str = Query(default=""),
    db: Session = Depends(get_db),
):
    """HTMX partial: search results for domain filter."""
    from ..models import Credential
    from sqlalchemy import func

    if not q.strip():
        return templates.TemplateResponse(request, "_domain_list.html", {
            "domains": [],
            "query": q,
        })

    domains_data = (
        db.query(Credential.domain, func.count(Credential.id).label("count"))
        .filter(Credential.domain.contains(q.strip().lower()))
        .group_by(Credential.domain)
        .order_by(func.count(Credential.id).desc())
        .limit(50)
        .all()
    )

    return templates.TemplateResponse(request, "_domain_list.html", {
        "domains": domains_data,
        "query": q,
    })


@router.get("/domain/{domain}", response_class=HTMLResponse)
def domain_detail(
    request: Request,
    domain: str,
    page: int = Query(default=1, ge=1),
    db: Session = Depends(get_db),
):
    """View all credentials for a specific domain."""
    page_size = 50
    domain = domain.strip().lower()
    total = core.count_by_domain(db, domain)
    creds = core.query_by_domain(db, domain, limit=page_size, offset=(page - 1) * page_size)
    total_pages = max(1, (total + page_size - 1) // page_size)

    return templates.TemplateResponse(request, "detail.html", {
        "domain": domain,
        "credentials": creds,
        "total": total,
        "page": page,
        "total_pages": total_pages,
    })


@router.get("/domain/{domain}/export")
def export_domain_csv(
    domain: str,
    db: Session = Depends(get_db),
):
    """Export credentials for a domain as CSV."""
    domain = domain.strip().lower()
    creds = core.query_by_domain(db, domain, limit=10000)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["account", "password", "source", "created_at"])
    for c in creds:
        writer.writerow([c.account, c.password, c.source, str(c.created_at or "")])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={domain}_credentials.csv"},
    )


@router.get("/manage", response_class=HTMLResponse)
def manage_page(request: Request):
    """Data management page."""
    return templates.TemplateResponse(request, "manage.html")


@router.post("/manage/add", response_class=HTMLResponse)
def manage_add(
    request: Request,
    domain: str = Form(...),
    account: str = Form(...),
    password: str = Form(...),
    source: str = Form(default=""),
    db: Session = Depends(get_db),
):
    """Add a single credential via the manage page."""
    try:
        validated = CredentialInput(domain=domain, account=account, password=password, source=source)
        cred = core.store_credential(db, validated.domain, validated.account, validated.password, validated.source)
        if cred:
            message = f"Successfully added credential for {validated.domain}"
            msg_type = "success"
        else:
            message = f"Credential for {validated.domain} already exists"
            msg_type = "warning"
    except ValidationError as e:
        message = f"Validation error: {e.errors()[0]['msg']}"
        msg_type = "error"
    except Exception as e:
        message = f"Error: {str(e)}"
        msg_type = "error"

    stats = core.get_statistics(db)
    return templates.TemplateResponse(request, "manage.html", {
        "message": message,
        "msg_type": msg_type,
        "stats": stats,
    })


@router.post("/manage/delete/{credential_id}")
def manage_delete(
    credential_id: int,
    db: Session = Depends(get_db),
):
    """Delete a credential by ID (HTMX endpoint)."""
    if core.delete_credential(db, credential_id):
        return HTMLResponse('<div class="text-green-400">Deleted successfully</div>')
    raise HTTPException(status_code=404, detail="Not found")


@router.post("/manage/delete-domain/{domain}")
def manage_delete_domain(
    domain: str,
    db: Session = Depends(get_db),
):
    """Delete all credentials for a domain (HTMX endpoint)."""
    count = core.delete_by_domain(db, domain)
    return HTMLResponse(f'<div class="text-green-400">Deleted {count} credentials for {domain}</div>')
