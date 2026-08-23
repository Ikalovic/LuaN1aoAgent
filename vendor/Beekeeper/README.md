# Beekeeper 🐝

Credential leak database manager for web penetration testing.

Beekeeper is a module for managing and querying credential databases (username + password pairs), designed as a component of a Web penetration testing agent ecosystem.

## Features

- **REST API** — FastAPI endpoints for storing and querying credentials, with API key authentication
- **MCP Tools** — Model Context Protocol interface for AI agents to query the database (read-only, limited results)
- **WebUI** — Browse and manage credential data with a clean dark-themed interface
- **SQLite Backend** — Zero-config, self-contained database with WAL mode for concurrent access
- **Security** — API key auth, input validation, security headers, localhost-only binding

## Quick Start

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd Beekeeper

# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -e ".[dev]"
```

### Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `BEEKEEPER_DATABASE_URL` | `sqlite:///data/beekeeper.db` | Database connection URL |
| `BEEKEEPER_API_KEY` | `change-me-in-production` | API key for REST endpoints |
| `BEEKEEPER_HOST` | `127.0.0.1` | Server bind address |
| `BEEKEEPER_PORT` | `8901` | Server port |
| `BEEKEEPER_MCP_RESULT_LIMIT` | `10` | Max results returned via MCP |
| `BEEKEEPER_BULK_IMPORT_BATCH_SIZE` | `1000` | Batch size for bulk imports |

### Running

**Start the Web API + WebUI server:**

```bash
uvicorn beekeeper.main:app --host 127.0.0.1 --port 8901 --reload
```

**Start the MCP server (stdio transport):**

```bash
python mcp_main.py
```

### API Usage

**Store a credential:**

```bash
curl -X POST http://127.0.0.1:8901/api/v1/credentials \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"domain": "example.com", "account": "admin", "password": "p@ssw0rd", "source": "leak-2024"}'
```

**Query credentials by domain:**

```bash
curl http://127.0.0.1:8901/api/v1/credentials/example.com \
  -H "X-API-Key: your-api-key"
```

**Get statistics:**

```bash
curl http://127.0.0.1:8901/api/v1/statistics \
  -H "X-API-Key: your-api-key"
```

**Bulk import:**

```bash
curl -X POST http://127.0.0.1:8901/api/v1/credentials/bulk \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '[
    {"domain": "example.com", "account": "user1", "password": "pass1"},
    {"domain": "example.com", "account": "user2", "password": "pass2"}
  ]'
```

### WebUI

Open http://127.0.0.1:8901/ in your browser to access the WebUI:

- **Dashboard** — Statistics overview and quick search
- **Browse** — Browse domains with real-time search, click to view credentials
- **Manage** — Add, import, and delete credentials

### MCP Integration

The MCP server provides three read-only tools for AI agents:

1. **query_credentials(domain)** — Query credentials (limited to 10 results)
2. **credential_statistics()** — Get database statistics
3. **get_database_info()** — Get database path and schema for writing custom query scripts

For bulk operations, AI agents should use the database path from `get_database_info()` to write direct SQLite queries.

## Development

### Running Tests

```bash
pytest tests/ -v
```

### Project Structure

```
beekeeper/
├── pyproject.toml          # Project config & dependencies
├── beekeeper/
│   ├── config.py           # Settings (pydantic-settings)
│   ├── database.py         # SQLAlchemy engine + SQLite PRAGMA
│   ├── models.py           # Data models
│   ├── schemas.py          # Pydantic validation
│   ├── core.py             # Business logic (CRUD)
│   ├── main.py             # FastAPI application
│   ├── api/
│   │   ├── deps.py         # API key auth
│   │   ├── credentials.py  # REST endpoints
│   │   └── middleware.py   # Security headers + CORS
│   ├── mcp_server/
│   │   └── server.py       # MCP tools
│   └── web/
│       ├── routes.py       # WebUI routes
│       └── templates/      # Jinja2 + HTMX templates
├── mcp_main.py             # MCP server entry point
└── tests/                  # Test suite
```

## Security Notes

- **Default binding**: 127.0.0.1 (localhost only). Do NOT bind to 0.0.0.0 in production without proper authentication.
- **API Key**: Change the default API key in production via `BEEKEEPER_API_KEY` environment variable.
- **Database**: Credentials are stored in plaintext. Protect the database file with appropriate filesystem permissions (chmod 600).
- **MCP**: The MCP interface is read-only and limits results to prevent bulk data exposure.
- **Backups**: Regularly backup the SQLite database file.

## License

MIT
