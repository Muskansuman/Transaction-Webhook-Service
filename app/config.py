import os

DEFAULT_DATABASE_URL = "postgresql+psycopg://postgres:postgres@localhost:5432/transactions"


def database_url() -> str:
    url = os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def processing_delay_seconds() -> float:
    return float(os.getenv("PROCESSING_DELAY_SECONDS", "30"))


def recovery_interval_seconds() -> float:
    return float(os.getenv("RECOVERY_INTERVAL_SECONDS", "5"))


def cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*")
    return [item.strip() for item in raw.split(",") if item.strip()] or ["*"]
