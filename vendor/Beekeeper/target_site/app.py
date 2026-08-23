"""Demo target site — simulates target-company.com services for penetration testing demos."""
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

app = FastAPI(title="Target Company Demo")

# Service definitions — maps subdomain paths to service info
SERVICES = {
    "vpn": {
        "name": "VPN Portal",
        "domain": "vpn.target-company.com",
        "icon": "🔒",
        "description": "Remote Access VPN Gateway",
        "color": "blue",
    },
    "mail": {
        "name": "Webmail",
        "domain": "mail.target-company.com",
        "icon": "📧",
        "description": "Corporate Email System",
        "color": "green",
    },
    "jira": {
        "name": "Jira",
        "domain": "jira.target-company.com",
        "icon": "📋",
        "description": "Project Management System",
        "color": "purple",
        "color_hex": "#7c3aed",
    },
    "gitlab": {
        "name": "GitLab",
        "domain": "gitlab.target-company.com",
        "icon": "🔧",
        "description": "Source Code Repository",
        "color": "orange",
        "color_hex": "#ea580c",
    },
    "admin": {
        "name": "Admin Panel",
        "domain": "admin.internal-corp.com",
        "icon": "⚙️",
        "description": "Internal Administration Console",
        "color": "red",
        "color_hex": "#dc2626",
    },
}

# Track login attempts for demo purposes
login_attempts = []

# Only ONE correct credential per service
VALID_CREDENTIALS = {
    "vpn": ("employee01", "Empl01@VPN"),
    "mail": ("ceo", "CE0@Target!"),
    "jira": ("dev-team", "D3vTe@m#1"),
    "gitlab": ("devops", "Dev0ps@CI"),
    "admin": ("administrator", "Admin@2024!"),
}

@app.get("/", response_class=HTMLResponse)
def portal(request: Request):
    """Landing page — shows all available services."""
    return templates.TemplateResponse(request, "portal.html", {
        "services": SERVICES,
        "attempts": login_attempts[-20:],
    })

@app.get("/login/{service}", response_class=HTMLResponse)
def login_page(request: Request, service: str):
    """Login page for a specific service."""
    if service not in SERVICES:
        return RedirectResponse("/")
    svc = SERVICES[service]
    return templates.TemplateResponse(request, "login.html", {
        "service": service,
        "svc": svc,
        "error": None,
    })

@app.post("/login/{service}")
def login_attempt(
    request: Request,
    service: str,
    username: str = Form(...),
    password: str = Form(...),
):
    """Process login — checks against hardcoded valid credentials."""
    if service not in SERVICES:
        return RedirectResponse("/")
    
    svc = SERVICES[service]
    valid_cred = VALID_CREDENTIALS.get(service)
    valid = valid_cred and username == valid_cred[0] and password == valid_cred[1]
    
    # Record the attempt
    attempt = {
        "service": svc["name"],
        "domain": svc["domain"],
        "username": username,
        "password": password,
        "success": valid,
    }
    login_attempts.append(attempt)
    
    if valid:
        return templates.TemplateResponse(request, "dashboard.html", {
            "service": service,
            "svc": svc,
            "username": username,
        })
    else:
        return templates.TemplateResponse(request, "login.html", {
            "service": service,
            "svc": svc,
            "error": "Invalid credentials. Access denied.",
            "username": username,
        })

@app.get("/attempts")
def get_attempts():
    """API endpoint to view login attempts."""
    return {"attempts": login_attempts[-50:]}
