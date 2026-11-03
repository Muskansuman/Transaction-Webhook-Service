import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.db import clear_transactions, init_db
from app.main import app
from app.schemas import WebhookRequest


@pytest.fixture
def client():
    init_db()
    clear_transactions()
    with TestClient(app) as test_client:
        yield test_client
    clear_transactions()


def webhook(transaction_id: str = "txn_abc123def456", amount: str = "1500") -> dict:
    return {
        "transaction_id": transaction_id,
        "source_account": "acc_user_789",
        "destination_account": "acc_merchant_456",
        "amount": amount,
        "currency": "INR",
    }


def wait_for_status(client: TestClient, transaction_id: str, status: str, timeout: float = 5) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        response = client.get(f"/v1/transactions/{transaction_id}")
        if response.status_code == 200:
            last = response.json()[0]
            if last["status"] == status:
                return last
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {status}: {last}")


def test_health(client: TestClient):
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "HEALTHY"
    assert body["current_time"].endswith("Z")


def test_webhook_is_processed_after_the_delay(client: TestClient):
    started = time.perf_counter()
    response = client.post("/v1/webhooks/transactions", json=webhook())
    elapsed = time.perf_counter() - started

    assert response.status_code == 202
    assert elapsed < 0.5
    assert response.json() == {"status": "accepted"}
    assert response.headers["X-Webhook-Result"] == "created"

    pending = client.get("/v1/transactions/txn_abc123def456")
    assert pending.status_code == 200
    pending_body = pending.json()[0]
    assert pending_body["status"] == "PROCESSING"
    assert pending_body["processed_at"] is None
    assert pending_body["amount"] == 1500

    done = wait_for_status(client, "txn_abc123def456", "PROCESSED")
    assert done["processed_at"] is not None
    assert done["currency"] == "INR"
    assert done["source_account"] == "acc_user_789"


def test_duplicate_webhooks_create_one_transaction(client: TestClient):
    statuses = [
        client.post("/v1/webhooks/transactions", json=webhook("txn_duplicate", "150.50")).status_code
        for _ in range(10)
    ]
    assert statuses == [202] * 10

    done = wait_for_status(client, "txn_duplicate", "PROCESSED")
    assert done["amount"] == 150.5
    changed = webhook("txn_duplicate", "999")
    changed["destination_account"] = "acc_other"
    again = client.post("/v1/webhooks/transactions", json=changed)
    assert again.status_code == 202
    assert again.headers["X-Webhook-Result"] == "duplicate"

    current = client.get("/v1/transactions/txn_duplicate").json()[0]
    assert current["amount"] == 150.5
    assert current["destination_account"] == "acc_merchant_456"


def test_concurrent_duplicates_insert_once():
    init_db()
    clear_transactions()
    payload = WebhookRequest.model_validate(webhook("txn_concurrent"))
    from app.db import insert_if_new

    with ThreadPoolExecutor(max_workers=8) as pool:
        created = list(pool.map(lambda _: insert_if_new(payload), range(8)))
    assert created.count(True) == 1
    clear_transactions()


def test_invalid_webhook_is_rejected(client: TestClient):
    response = client.post("/v1/webhooks/transactions", json={"transaction_id": "txn_bad"})
    assert response.status_code == 422
    missing = client.get("/v1/transactions/txn_does_not_exist")
    assert missing.status_code == 404
