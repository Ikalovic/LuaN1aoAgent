from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "sqlite:///data/beekeeper.db"
    api_key: str = "change-me-in-production"
    host: str = "127.0.0.1"
    port: int = 8901
    mcp_result_limit: int = 10
    bulk_import_batch_size: int = 1000

    model_config = {"env_prefix": "BEEKEEPER_", "env_file": ".env"}

settings = Settings()
