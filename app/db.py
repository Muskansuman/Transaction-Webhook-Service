from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, String, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from app.config import database_url
from app.schemas import WebhookRequest

PROCESSING = "PROCESSING"
PROCESSED = "PROCESSED"


class Base(DeclarativeBase):
    pass


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    source_account: Mapped[str] = mapped_column(String(128))
    destination_account: Mapped[str] = mapped_column(String(128))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(16), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


_engine = None


def get_engine():
    global _engine
    if _engine is None:
        from sqlalchemy import create_engine

        _engine = create_engine(database_url(), pool_pre_ping=True)
    return _engine


def init_db() -> None:
    Base.metadata.create_all(get_engine())


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def insert_if_new(payload: WebhookRequest) -> bool:
    statement = (
        pg_insert(Transaction)
        .values(
            transaction_id=payload.transaction_id,
            source_account=payload.source_account,
            destination_account=payload.destination_account,
            amount=payload.amount,
            currency=payload.currency,
            status=PROCESSING,
            created_at=utc_now(),
            processed_at=None,
        )
        .on_conflict_do_nothing(index_elements=["transaction_id"])
        .returning(Transaction.id)
    )
    with Session(get_engine()) as session:
        created_id = session.scalar(statement)
        session.commit()
        return created_id is not None


def get_transaction(transaction_id: str) -> Transaction | None:
    with Session(get_engine()) as session:
        row = session.scalar(select(Transaction).where(Transaction.transaction_id == transaction_id))
        if row is not None:
            session.expunge(row)
        return row


def list_processing_ids() -> list[str]:
    with Session(get_engine()) as session:
        return list(session.scalars(select(Transaction.transaction_id).where(Transaction.status == PROCESSING)))


def mark_processed(transaction_id: str) -> None:
    with Session(get_engine()) as session:
        session.execute(
            update(Transaction)
            .where(Transaction.transaction_id == transaction_id)
            .where(Transaction.status == PROCESSING)
            .values(status=PROCESSED, processed_at=utc_now())
        )
        session.commit()


def clear_transactions() -> None:
    with Session(get_engine()) as session:
        session.execute(Transaction.__table__.delete())
        session.commit()
