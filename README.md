# Transaction Webhook Service

A Python service that accepts payment-processor webhooks, returns **202 Accepted** in under 500 ms, and finishes each transaction in the background.

The database row is the queue. A unique `transaction_id` prevents duplicate processing, and any row still marked `PROCESSING` is resumed after a restart.

## Architecture

```mermaid
flowchart LR
    Processor["Payment processor"]
    API["FastAPI webhook API<br/>validate, insert, return 202"]
    Query["Status query API<br/>GET /v1/transactions/{id}"]
    DB[("PostgreSQL<br/>durable transaction row")]
    Worker["Background worker<br/>recover, wait, complete"]
    External["External service<br/>simulated 30s call"]

    Processor -->|"POST /v1/webhooks/transactions"| API
    API -->|"INSERT if new"| DB
    API -->|"202 Accepted"| Processor
    DB -->|"claim PROCESSING rows"| Worker
    Worker -->|"30 second call"| External
    External -->|"result"| Worker
    Worker -->|"set PROCESSED"| DB
    Processor -->|"GET status"| Query
    Query -->|"SELECT"| DB
```



The webhook handler never waits on the 30-second call. It writes the row, then returns.

## Full process

```mermaid
sequenceDiagram
    participant P as Payment processor
    participant A as Webhook API
    participant D as PostgreSQL
    participant W as Background worker

    P->>A: POST /v1/webhooks/transactions
    A->>A: Validate payload
    A->>D: INSERT transaction_id, status=PROCESSING
    alt transaction_id already exists
        D-->>A: conflict, no new row
        A-->>P: 202 Accepted
    else first delivery
        D-->>A: row created
        A-->>P: 202 Accepted
        A->>W: schedule this transaction
        W->>W: sleep 30 seconds
        W->>D: UPDATE status=PROCESSED, processed_at=now
    end
    P->>A: GET /v1/transactions/{transaction_id}
    A->>D: SELECT by transaction_id
    D-->>A: PROCESSING or PROCESSED
    A-->>P: one-element array
```





## Each step



### 1. Receive the webhook

`POST /v1/webhooks/transactions` accepts:

```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR"
}
```

Pydantic rejects a missing or invalid body with **422**. A valid body continues to the insert.

### 2. Persist before acknowledging

Insert one row:


| Column                | Value on insert          |
| --------------------- | ------------------------ |
| `transaction_id`      | from the webhook, unique |
| `source_account`      | from the webhook         |
| `destination_account` | from the webhook         |
| `amount`              | decimal, not float       |
| `currency`            | from the webhook         |
| `status`              | `PROCESSING`             |
| `created_at`          | current UTC time         |
| `processed_at`        | `null`                   |


`INSERT ... ON CONFLICT (transaction_id) DO NOTHING` is the idempotency boundary. Two identical requests at the same time still create one row.

### 3. Return 202 immediately

- New row: return **202** and schedule processing.
- Existing `transaction_id`: return **202** and do not schedule another job. The first payload is kept even if a later webhook differs.
- The response body may be empty or a short acknowledgement.
- The handler does not sleep and does not call the external service.



### 4. Process in the background

The worker waits **30 seconds** to simulate an external API call, then updates that row only if it is still `PROCESSING`:

- `status` becomes `PROCESSED`
- `processed_at` becomes the current UTC time

A second run of the same job finds the row already finished and does nothing.

### 5. Recover after a restart

On startup, and every few seconds after that, the worker loads every row still in `PROCESSING` and schedules those jobs again. A row that is already scheduled in this process is not started twice. The row was committed before the 202, so a crash during the 30-second wait does not drop the transaction.

### 6. Read the status

`GET /v1/transactions/{transaction_id}` returns a one-element array:

```json
[
  {
    "transaction_id": "txn_abc123def456",
    "source_account": "acc_user_789",
    "destination_account": "acc_merchant_456",
    "amount": 1500,
    "currency": "INR",
    "status": "PROCESSED",
    "created_at": "2024-01-15T10:30:00Z",
    "processed_at": "2024-01-15T10:30:30Z"
  }
]
```

`processed_at` is `null` while `status` is `PROCESSING`.

### 7. Health check

`GET /` returns:

```json
{
  "status": "HEALTHY",
  "current_time": "2024-01-15T10:30:00Z"
}
```



## State

```mermaid
stateDiagram-v2
    [*] --> PROCESSING: first webhook inserted
    PROCESSING --> PROCESSED: worker finishes the 30s call
    PROCESSED --> PROCESSED: duplicate webhook, no new work
```





## Why this shape

- **Fast acknowledgement.** The only work on the request path is validation and one database insert, which stays under 500 ms when the app and database are in the same region.
- **No lost work.** The row exists before the response. Restart recovery resumes `PROCESSING` rows.
- **No duplicate processing.** The unique key, not an in-memory set, decides whether work starts.
- **One service to deploy.** PostgreSQL is both the store and the queue, so the app does not need Redis, Celery, or Kafka for this workload.

## Run

Requires Docker.

```bash
docker compose up --build
```

The API listens on `http://localhost:8000`. `PROCESSING_DELAY_SECONDS` defaults to `30`.

Health:

```bash
curl http://localhost:8000/
```

Accept a webhook:

```bash
curl -i -X POST http://localhost:8000/v1/webhooks/transactions \
  -H 'Content-Type: application/json' \
  -d '{
    "transaction_id": "txn_abc123def456",
    "source_account": "acc_user_789",
    "destination_account": "acc_merchant_456",
    "amount": 1500,
    "currency": "INR"
  }'
```

Read it immediately, then again after about 30 seconds:

```bash
curl http://localhost:8000/v1/transactions/txn_abc123def456
```

Send that same body again. The response is still `202`, and the stored amount and accounts stay as they were on the first delivery.

Run the service without the API container:

```bash
docker compose up db -d
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/transactions
export PROCESSING_DELAY_SECONDS=30
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Test

The tests use the same Postgres database and a short processing delay.

```bash
docker compose up db -d
source .venv/bin/activate
pytest
```

A missing field returns `422`. An unknown `transaction_id` returns `404`. If Postgres is unavailable, the webhook returns `503` and does not acknowledge work that was not stored.

