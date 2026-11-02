import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://postgres:postgres@localhost:5432/transactions",
)
os.environ["PROCESSING_DELAY_SECONDS"] = "1"
os.environ["RECOVERY_INTERVAL_SECONDS"] = "0.25"
