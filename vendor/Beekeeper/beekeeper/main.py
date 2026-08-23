import uvicorn
from fastapi import FastAPI
from contextlib import asynccontextmanager

from .config import settings
from .database import init_db
from .api.credentials import router as credentials_router
from .api.middleware import add_security_middleware
from .web.routes import router as web_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(
    title="Beekeeper",
    description="Credential leak database manager for web penetration testing",
    version="0.1.0",
    lifespan=lifespan,
)

add_security_middleware(app)
app.include_router(credentials_router)
app.include_router(web_router)

def main():
    uvicorn.run(
        "beekeeper.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )

if __name__ == "__main__":
    main()
