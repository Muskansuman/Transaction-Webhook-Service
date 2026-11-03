"""Edge cases and the assumptions the service actually makes.

Assumptions covered here:
- A 202 means the webhook was stored or already known. It does not mean processing finished.
- Repeating a transaction_id returns 202 and keeps the first payload, even when later fields differ.
- Whitespace around the id and account fields is ignored. Currency is stored in uppercase, but it must already be exactly 3 characters. A padded value such as " inr " is rejected.
- The status route returns a one-element array. processed_at is null until PROCESSED.
- Whole-number amounts are JSON integers. Fractional amounts stay decimal.
- The same source and destination account is allowed.
- GET / reports liveness and does not read the database.
- A database error on write or read is 503, and nothing is acknowledged as accepted.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.db import clear_transactions, get_transaction, init_db
from app.main import app


@pytest.fixture
def client():
    init_db()
    clear_transactions()
    with TestClient(app) as test_client:
        yield test_client
    clear_transactions()


def test_whitespace_is_stripped_and_currency_is_normalized(client):
    response = client.post(
        "/v1/webhooks/transactions",
        json={
            "transaction_id": "  txn_trim  ",
            "source_account": " acc_user_789 ",
            "destination_account": " acc_merchant_456 ",
            "amount": "1500.50",
            "currency": "inr",
        },
    )
    assert response.status_code == 202

    body = client.get("/v1/transactions/txn_trim").json()
    assert len(body) == 1
    row = body[0]
    assert row["transaction_id"] == "txn_trim"
    assert row["source_account"] == "acc_user_789"
    assert row["destination_account"] == "acc_merchant_456"
    assert row["currency"] == "INR"
    assert row["amount"] == 1500.5
    assert row["status"] == "PROCESSING"
    assert row["processed_at"] is None

    padded_currency = client.post(
        "/v1/webhooks/transactions",
        json={
            "transaction_id": "txn_padded_currency",
            "source_account": "acc_user_789",
            "destination_account": "acc_merchant_456",
            "amount": 1,
            "currency": " inr ",
        },
    )
    assert padded_currency.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"transaction_id": "txn_only"},
        {"transaction_id": "   ", "source_account": "a", "destination_account": "b", "amount": 1, "currency": "INR"},
        {"transaction_id": "txn_zero", "source_account": "a", "destination_account": "b", "amount": 0, "currency": "INR"},
        {"transaction_id": "txn_neg", "source_account": "a", "destination_account": "b", "amount": -1, "currency": "INR"},
        {"transaction_id": "txn_places", "source_account": "a", "destination_account": "b", "amount": "1.234", "currency": "INR"},
        {"transaction_id": "txn_cur", "source_account": "a", "destination_account": "b", "amount": 1, "currency": "IN"},
        {"transaction_id": "txn_cur2", "source_account": "a", "destination_account": "b", "amount": 1, "currency": "INRX"},
        {"transaction_id": "txn_cur3", "source_account": "a", "destination_account": "b", "amount": 1, "currency": "12A"},
        {"transaction_id": "a" * 129, "source_account": "a", "destination_account": "b", "amount": 1, "currency": "INR"},
    ],
)
def test_invalid_payloads_are_rejected(client, payload):
    response = client.post("/v1/webhooks/transactions", json=payload)
    assert response.status_code == 422
    transaction_id = payload.get("transaction_id")
    if isinstance(transaction_id, str):
        cleaned = transaction_id.strip()
        if cleaned and len(cleaned) <= 128:
            assert client.get(f"/v1/transactions/{cleaned}").status_code == 404


def test_same_source_and_destination_is_accepted(client):
    response = client.post(
        "/v1/webhooks/transactions",
        json={
            "transaction_id": "txn_same_account",
            "source_account": "acc_same",
            "destination_account": "acc_same",
            "amount": 1,
            "currency": "USD",
        },
    )
    assert response.status_code == 202
    row = client.get("/v1/transactions/txn_same_account").json()[0]
    assert row["source_account"] == row["destination_account"] == "acc_same"


def test_extra_fields_are_ignored(client):
    payload = {
        "transaction_id": "txn_extra",
        "source_account": "acc_user_789",
        "destination_account": "acc_merchant_456",
        "amount": 10,
        "currency": "INR",
        "status": "PROCESSED",
        "note": "ignored",
    }
    assert client.post("/v1/webhooks/transactions", json=payload).status_code == 202
    row = client.get("/v1/transactions/txn_extra").json()[0]
    assert row["status"] == "PROCESSING"
    assert "note" not in row


def test_repeated_id_keeps_the_first_payload_after_processing(client):
    from tests.test_webhook import wait_for_status, webhook

    assert client.post("/v1/webhooks/transactions", json=webhook("txn_keep", "25.5")).status_code == 202
    done = wait_for_status(client, "txn_keep", "PROCESSED")
    assert done["amount"] == 25.5
    assert done["processed_at"] is not None

    changed = webhook("txn_keep", "999")
    changed["source_account"] = "acc_other"
    changed["currency"] = "USD"
    again = client.post("/v1/webhooks/transactions", json=changed)
    assert again.status_code == 202

    current = client.get("/v1/transactions/txn_keep").json()[0]
    assert current["status"] == "PROCESSED"
    assert current["amount"] == 25.5
    assert current["source_account"] == "acc_user_789"
    assert current["currency"] == "INR"
    assert current["processed_at"] == done["processed_at"]


def test_unknown_transaction_is_a_not_found_object(client):
    response = client.get("/v1/transactions/txn_missing")
    assert response.status_code == 404
    assert response.json()["detail"] == "transaction not found"


def test_health_stays_healthy_when_storage_reads_fail(client, monkeypatch):
    def boom(_transaction_id):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    monkeypatch.setattr("app.main.get_transaction", boom)
    health = client.get("/")
    assert health.status_code == 200
    assert health.json()["status"] == "HEALTHY"
    assert health.json()["current_time"].endswith("Z")

    status = client.get("/v1/transactions/txn_any")
    assert status.status_code == 503
    assert status.json()["detail"] == "storage unavailable"


def test_storage_failure_does_not_acknowledge_the_webhook(client, monkeypatch):
    def boom(_payload):
        raise OperationalError("INSERT", {}, Exception("db down"))

    monkeypatch.setattr("app.main.insert_if_new", boom)
    response = client.post(
        "/v1/webhooks/transactions",
        json={
            "transaction_id": "txn_unstored",
            "source_account": "acc_user_789",
            "destination_account": "acc_merchant_456",
            "amount": 1500,
            "currency": "INR",
        },
    )
    assert response.status_code == 503
    assert get_transaction("txn_unstored") is None

def test_whole_amounts_are_integers_and_max_length_id_is_kept(client):
    transaction_id = "t" * 128
    response = client.post(
        "/v1/webhooks/transactions",
        json={
            "transaction_id": transaction_id,
            "source_account": "s" * 128,
            "destination_account": "d" * 128,
            "amount": 1500,
            "currency": "eur",
        },
    )
    assert response.status_code == 202
    row = client.get(f"/v1/transactions/{transaction_id}").json()[0]
    assert row["amount"] == 1500
    assert isinstance(row["amount"], int)
    assert row["currency"] == "EUR"
    assert len(row["source_account"]) == 128

