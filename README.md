# Transaction Webhook Service

A Python service that accepts payment-processor webhooks, returns **202 Accepted** in under 500 ms, and finishes each transaction in the background.

Public API[http://130.210.26.235:8000/]: `http://130.210.26.235:8000`  
Public UI[http://130.210.26.235:8000/ui/]: `http://130.210.26.235:8000/ui/`

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

The deployed UI is served by the API container at `/ui/`. Open `http://130.210.26.235:8000/ui/` after the OCI containers are up. To work on the page locally instead:

```bash
unzip frontend.zip
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173/ui/`. Frontend checks live in `frontend/src/form.test.js` (`npm test` inside `frontend`).

## Deploy on Oracle Cloud

One Ubuntu virtual machine runs the API and PostgreSQL with Docker Compose. Postgres data stays in a volume and is not opened to the internet. Keep a single API container, because the background scheduler lives in that process.

This deployment is:

- API: `http://130.210.26.235:8000/`
- UI: `http://130.210.26.235:8000/ui/`

`docker-compose.oci.yml` sets `restart: unless-stopped` on `api` and `db`, so both come back after a VM reboot or a container crash. Use `up -d` so they stay in the background. Do not run `docker compose down` unless you intend to stop the public site.

### 1. Sign in

Open [https://cloud.oracle.com](https://cloud.oracle.com) and sign in to the tenancy. The instance is created under **Compute → Instances → Create instance**.

### 2. Image and shape

- **Image:** Canonical Ubuntu 22.04 or 24.04.
- **Shape:** `VM.Standard.E2.1.Micro` (Always Free: 1 OCPU, 1 GB memory). This is the shape used here. `VM.Standard.A1.Flex` with 1 OCPU and 6 GB is easier to build on when that capacity is free. On the 1 GB shape, add swap before the Docker build or the build can be killed.



### 3. Networking

Under **Primary VNIC**:

- Leave the VNIC name blank.
- Choose **Create new virtual cloud network**.
- Create a new public subnet.
- Turn on **Assign a public IPv4 address**.

After the work request **Create instance** succeeds, open the instance **Details** page and copy **Public IP address**. It looks like `130.210.26.235`. The address `192.168.x.x` on the same page is private and cannot be used from your computer.

### 4. SSH key

On the create-instance form, choose **Generate a key pair for me** and download both files. This deployment uses `~/Downloads/ssh-key-2026-11-02.key`.

Log in with the private key, the file that does not end in `.pub`. The username for the Ubuntu image is `ubuntu`.

```bash
chmod 600 ~/Downloads/ssh-key-2026-11-02.key
ssh -i ~/Downloads/ssh-key-2026-11-02.key ubuntu@130.210.26.235
```

`ssh-key-2026-11-02.key.pub` is only the public half. It cannot open a shell.

### 5. Open port 8000

The API answers on the VM before this step, but the public address stays closed until both of these are done.

In the console: menu → **Networking** → **Virtual cloud networks** → the instance VCN → **Subnets** → the public subnet → **Security lists** → the default security list → **Add Ingress Rules**:


| Field                  | Value       |
| ---------------------- | ----------- |
| Stateless              | off         |
| Source type            | CIDR        |
| Source CIDR            | `0.0.0.0/0` |
| IP protocol            | TCP         |
| Source port range      | empty       |
| Destination port range | `8000`      |


Leave port 5432 closed. Port 22 is already allowed for SSH.

On the VM, Ubuntu also filters the port:

```bash
sudo iptables -I INPUT -p tcp --dport 8000 -j ACCEPT
sudo apt-get update
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```



### 6. Instance setup

Still on the VM, install Docker and add swap for the 1 GB shape:

```bash
sudo apt-get install -y docker.io docker-compose-v2
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo usermod -aG docker ubuntu
exit
```

Log in again so the `docker` group applies. On your laptop, build the UI, then copy the project (include `frontend/dist`):

```bash
cd ~/dsm/frontend
rm -f .env
npm install
npm run build

rsync -av \
  --exclude .venv --exclude __pycache__ --exclude .pytest_cache \
  --exclude .git --exclude .env --exclude frontend/node_modules \
  --exclude frontend/.env \
  -e "ssh -i ~/Downloads/ssh-key-2026-11-02.key" \
  ~/dsm/ ubuntu@130.210.26.235:~/dsm/
```

On the VM:

```bash
cd ~/dsm
cp .env.oci.example .env
```

Edit `.env` and set `POSTGRES_PASSWORD` to a long value made of letters and numbers only. Characters such as `@` or `:` break `DATABASE_URL`. Then:

The UI is copied into the API image from `frontend/dist`. Do not set `VITE_API_URL` when building the UI, or the page will call localhost and show **Service unavailable**.

Start or refresh the containers on the VM. `-d` keeps them running after you disconnect:

```bash
cd ~/dsm
docker compose -f docker-compose.oci.yml up -d --build
docker compose -f docker-compose.oci.yml ps
```

`db` should be healthy and `api` running. Open from your computer:

- Health: `http://130.210.26.235:8000/`
- UI: `http://130.210.26.235:8000/ui/`

If the UI looks old, hard-refresh with Ctrl+Shift+R.

### 7. Update a running VM

Containers stay up. Postgres data stays in the `pgdata` volume. Copy the project, rebuild the UI, then recreate only what changed:

```bash
# on your laptop
cd ~/dsm/frontend
rm -f .env
npm run build

rsync -av \
  --exclude .venv --exclude __pycache__ --exclude .pytest_cache \
  --exclude .git --exclude .env --exclude frontend/node_modules \
  --exclude frontend/.env \
  -e "ssh -i ~/Downloads/ssh-key-2026-11-02.key" \
  ~/dsm/ ubuntu@130.210.26.235:~/dsm/
```

```bash
# on the VM
cd ~/dsm
docker compose -f docker-compose.oci.yml up -d --build
docker compose -f docker-compose.oci.yml ps
```

`up -d --build` rebuilds the API image (including `/ui/`) and replaces that container. The database container is left running.

Useful checks:

```bash
docker compose -f docker-compose.oci.yml ps
docker compose -f docker-compose.oci.yml logs -f api
```

### 8. Confirm the public API

Confirm from your own computer:

```bash
curl http://130.210.26.235:8000/

curl -i -X POST http://130.210.26.235:8000/v1/webhooks/transactions \
  -H 'Content-Type: application/json' \
  -d '{
    "transaction_id": "txn_oci_001",
    "source_account": "acc_user_789",
    "destination_account": "acc_merchant_456",
    "amount": 1500,
    "currency": "INR"
  }'

curl http://130.210.26.235:8000/v1/transactions/txn_oci_001
```

The first status call shows `PROCESSING`. About 30 seconds later the same call shows `PROCESSED`. A curl from the VM to its own public IP can hang even when this works. Test from your computer.
