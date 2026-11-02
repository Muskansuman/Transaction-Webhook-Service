#!/usr/bin/env bash
# Send the same webhook several times and wait until that one transaction is PROCESSED.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
COPIES="${COPIES:-4}"
TXN_ID="txn_e2e_$(date +%s)"
WAIT_SECONDS="${WAIT_SECONDS:-45}"

payload() {
  cat <<EOF
{
  "transaction_id": "${TXN_ID}",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR"
}
EOF
}

echo "Endpoint: ${BASE_URL}"
echo "Transaction: ${TXN_ID}"
echo

echo "== 1. Health =="
curl -fsS "${BASE_URL}/"
echo
echo

echo "== 2. Send the same payload ${COPIES} times (202 in under 500ms) =="
for i in $(seq 1 "${COPIES}"); do
  body_file="$(mktemp)"
  meta="$(curl -sS -o "${body_file}" -w "%{http_code} %{time_total}" \
    -X POST "${BASE_URL}/v1/webhooks/transactions" \
    -H "Content-Type: application/json" \
    -d "$(payload)")"
  code="${meta%% *}"
  seconds="${meta##* }"
  millis="$(awk -v t="${seconds}" 'BEGIN { printf "%d", t * 1000 }')"
  echo "request ${i}: HTTP ${code} in ${millis}ms $(cat "${body_file}")"
  rm -f "${body_file}"
  if [[ "${code}" != "202" ]]; then
    echo "request ${i} did not return 202" >&2
    exit 1
  fi
  if ! awk -v t="${seconds}" 'BEGIN { exit !(t < 0.5) }'; then
    echo "request ${i} took ${millis}ms, over the 500ms limit" >&2
    exit 1
  fi
done
echo

echo "== 3. Status right after the webhooks =="
curl -fsS "${BASE_URL}/v1/transactions/${TXN_ID}"
echo
echo

echo "== 4. Wait up to ${WAIT_SECONDS}s for PROCESSED =="
deadline=$((SECONDS + WAIT_SECONDS))
final=""
while (( SECONDS < deadline )); do
  final="$(curl -fsS "${BASE_URL}/v1/transactions/${TXN_ID}")"
  if [[ "${final}" == *'"status":"PROCESSED"'* || "${final}" == *'"status": "PROCESSED"'* ]]; then
    break
  fi
  sleep 2
  final=""
done

if [[ -z "${final}" ]]; then
  echo "timed out before the transaction reached PROCESSED" >&2
  exit 1
fi

echo "${final}"
echo

python3 - "${final}" <<'PY'
import json
import sys
from datetime import datetime

rows = json.loads(sys.argv[1])
if not isinstance(rows, list) or len(rows) != 1:
    raise SystemExit(f"expected one row, got {rows!r}")
row = rows[0]
if row["status"] != "PROCESSED":
    raise SystemExit(f"expected PROCESSED, got {row['status']}")
if row["processed_at"] is None:
    raise SystemExit("processed_at is null")
created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
processed = datetime.fromisoformat(row["processed_at"].replace("Z", "+00:00"))
delay = (processed - created).total_seconds()
if delay < 30:
    raise SystemExit(f"processing delay was {delay:.0f}s, expected at least 30s")
if row["amount"] != 1500:
    raise SystemExit(f"amount changed: {row['amount']}")
if row["source_account"] != "acc_user_789":
    raise SystemExit("source_account changed")
if row["destination_account"] != "acc_merchant_456":
    raise SystemExit("destination_account changed")
print(
    f"end-to-end passed: background job waited {delay:.0f}s "
    "and stored one PROCESSED transaction"
)
PY
