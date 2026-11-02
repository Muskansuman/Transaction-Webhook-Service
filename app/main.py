import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.db import get_transaction, init_db, insert_if_new, iso_z, utc_now
from app.schemas import TransactionResponse, WebhookRequest
from app.worker import recover_loop, schedule, stop_processing

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(init_db)
    stop = asyncio.Event()
    recovery = asyncio.create_task(recover_loop(stop), name="recover-processing")
    try:
        yield
    finally:
        stop.set()
        recovery.cancel()
        try:
            await recovery
        except asyncio.CancelledError:
            pass
        await stop_processing()


app = FastAPI(title="Transaction Webhook Service", lifespan=lifespan)


@app.get("/")
def health():
    return {"status": "HEALTHY", "current_time": iso_z(utc_now())}


@app.post("/v1/webhooks/transactions")
async def receive_webhook(payload: WebhookRequest):
    try:
        created = await asyncio.to_thread(insert_if_new, payload)
    except SQLAlchemyError:
        logger.exception("failed to store webhook %s", payload.transaction_id)
        raise HTTPException(status_code=503, detail="storage unavailable") from None
    if created:
        await schedule(payload.transaction_id)
        logger.info("accepted transaction %s", payload.transaction_id)
    else:
        logger.info("duplicate transaction %s ignored", payload.transaction_id)
    return JSONResponse(status_code=202, content={"status": "accepted"})


@app.get("/v1/transactions/{transaction_id}", response_model=list[TransactionResponse])
async def get_transaction_status(transaction_id: str):
    try:
        row = await asyncio.to_thread(get_transaction, transaction_id)
    except SQLAlchemyError:
        logger.exception("failed to read transaction %s", transaction_id)
        raise HTTPException(status_code=503, detail="storage unavailable") from None
    if row is None:
        raise HTTPException(status_code=404, detail="transaction not found")
    return [
        TransactionResponse(
            transaction_id=row.transaction_id,
            source_account=row.source_account,
            destination_account=row.destination_account,
            amount=row.amount,
            currency=row.currency,
            status=row.status,
            created_at=iso_z(row.created_at) or "",
            processed_at=iso_z(row.processed_at),
        )
    ]
