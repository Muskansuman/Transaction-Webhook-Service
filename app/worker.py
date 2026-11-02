import asyncio
import logging

from app.config import processing_delay_seconds, recovery_interval_seconds
from app.db import list_processing_ids, mark_processed

logger = logging.getLogger(__name__)

_scheduled: set[str] = set()
_tasks: set[asyncio.Task] = set()
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


async def schedule(transaction_id: str) -> None:
    async with _get_lock():
        if transaction_id in _scheduled:
            return
        _scheduled.add(transaction_id)
    task = asyncio.create_task(_process(transaction_id), name=f"process:{transaction_id}")
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _process(transaction_id: str) -> None:
    try:
        await asyncio.sleep(processing_delay_seconds())
        await asyncio.to_thread(mark_processed, transaction_id)
        logger.info("processed transaction %s", transaction_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("processing failed for %s", transaction_id)
    finally:
        _scheduled.discard(transaction_id)


async def recover_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            pending = await asyncio.to_thread(list_processing_ids)
            for transaction_id in pending:
                await schedule(transaction_id)
        except Exception:
            logger.exception("recovery scan failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=recovery_interval_seconds())
        except asyncio.TimeoutError:
            continue


async def stop_processing() -> None:
    tasks = list(_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
