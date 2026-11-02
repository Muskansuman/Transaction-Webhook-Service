import { useEffect, useState } from "react";
import { API_URL, fetchHealth, fetchTransaction, submitTransaction } from "./api.js";
import {
  PROCESSING_SECONDS,
  formatWhen,
  secondsRemaining,
  storedPaymentDiffers,
  toPayload,
  validateForm,
} from "./form.js";

const EMPTY_FORM = {
  transaction_id: "",
  source_account: "acc_user_789",
  destination_account: "acc_merchant_456",
  amount: "1500",
  currency: "INR",
};

function newTransactionId() {
  return `txn_${Date.now()}`;
}

function StatusCard({ transaction, submitted, now }) {
  const remaining =
    transaction?.status === "PROCESSING"
      ? secondsRemaining(transaction.created_at, now)
      : null;
  const progress =
    remaining == null ? 100 : Math.min(100, ((PROCESSING_SECONDS - remaining) / PROCESSING_SECONDS) * 100);
  const keptOriginal = submitted && storedPaymentDiffers(submitted, transaction);

  return (
    <section className="status" aria-live="polite">
      <h2>{transaction?.status === "PROCESSED" ? "Completed" : "Processing"}</h2>
      {transaction?.status !== "PROCESSED" && (
        <p className="hint">
          {remaining == null
            ? "Accepted. Checking the payment…"
            : remaining > 0
              ? `About ${remaining} seconds left. The service waits ${PROCESSING_SECONDS} seconds before it finishes.`
              : "The wait is over. Finishing the payment now."}
        </p>
      )}
      {transaction?.status !== "PROCESSED" && (
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {keptOriginal && (
        <p className="notice">
          This transaction ID was already used. The original payment is shown. A later
          submission does not change the amount or the accounts.
        </p>
      )}
      {transaction && (
        <dl>
          <div>
            <dt>Transaction</dt>
            <dd>{transaction.transaction_id}</dd>
          </div>
          <div>
            <dt>From</dt>
            <dd>{transaction.source_account}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{transaction.destination_account}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              {transaction.amount} {transaction.currency}
            </dd>
          </div>
          <div>
            <dt>Accepted</dt>
            <dd>{formatWhen(transaction.created_at)}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{formatWhen(transaction.processed_at)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FORM, transaction_id: newTransactionId() });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const [transaction, setTransaction] = useState(null);
  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [lookup, setLookup] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchHealth()
        .then((body) => {
          if (cancelled) return;
          setHealth(body);
          setHealthError("");
        })
        .catch((error) => {
          if (cancelled) return;
          setHealth(null);
          setHealthError(error.message);
        });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const transactionId = submitted?.transaction_id;
    if (!transactionId || transaction?.status === "PROCESSED") return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const row = await fetchTransaction(transactionId);
        if (!cancelled && row) {
          setTransaction(row);
          setSubmitError("");
        }
      } catch (error) {
        if (!cancelled) setSubmitError(error.message);
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [submitted, transaction?.status]);

  function updateField(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
  }

  async function onSubmit(event) {
    event.preventDefault();
    const errors = validateForm(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const payload = toPayload(form);
    setSubmitting(true);
    setSubmitError("");
    setSubmitted(null);
    setTransaction(null);
    try {
      await submitTransaction(payload);
      setSubmitted(payload);
    } catch (error) {
      setSubmitError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  function startAnother() {
    setForm({ ...EMPTY_FORM, transaction_id: newTransactionId() });
    setFieldErrors({});
    setSubmitted(null);
    setTransaction(null);
    setSubmitError("");
  }

  async function onLookup(event) {
    event.preventDefault();
    const transactionId = lookupId.trim();
    if (!transactionId) {
      setLookupError("Enter a transaction ID.");
      setLookup(null);
      return;
    }
    setLookupError("");
    try {
      const row = await fetchTransaction(transactionId);
      if (!row) {
        setLookup(null);
        setLookupError("No transaction exists with that ID.");
        return;
      }
      setLookup(row);
    } catch (error) {
      setLookup(null);
      setLookupError(error.message);
    }
  }

  return (
    <main>
      <header>
        <p className="eyebrow">Payments</p>
        <h1>Send a payment</h1>
        <p className="lede">
          The payment is accepted immediately. It stays in progress for about {PROCESSING_SECONDS}{" "}
          seconds, then this page updates on its own.
        </p>
      </header>

      <section className="health" aria-live="polite">
        {health && <span className="ok">Service is available</span>}
        {healthError && <span className="error">Service is unavailable. Try again shortly.</span>}
        {!health && !healthError && <span>Checking the service…</span>}
      </section>

      <form onSubmit={onSubmit} noValidate>
        <label>
          Transaction ID
          <input name="transaction_id" value={form.transaction_id} onChange={updateField} />
          <span className="field-hint">
            A new ID is filled in for you. Using an ID that already exists shows the original
            payment and does not change it.
          </span>
          {fieldErrors.transaction_id && <span className="error">{fieldErrors.transaction_id}</span>}
        </label>
        <label>
          From account
          <input name="source_account" value={form.source_account} onChange={updateField} />
          {fieldErrors.source_account && <span className="error">{fieldErrors.source_account}</span>}
        </label>
        <label>
          To account
          <input
            name="destination_account"
            value={form.destination_account}
            onChange={updateField}
          />
          {fieldErrors.destination_account && (
            <span className="error">{fieldErrors.destination_account}</span>
          )}
        </label>
        <div className="row">
          <label>
            Amount
            <input name="amount" inputMode="decimal" value={form.amount} onChange={updateField} />
            {fieldErrors.amount && <span className="error">{fieldErrors.amount}</span>}
          </label>
          <label>
            Currency
            <input
              name="currency"
              value={form.currency}
              onChange={updateField}
              maxLength={3}
            />
            {fieldErrors.currency && <span className="error">{fieldErrors.currency}</span>}
          </label>
        </div>
        <div className="actions">
          <button type="submit" disabled={submitting || Boolean(healthError)}>
            {submitting ? "Sending…" : "Send payment"}
          </button>
          <button type="button" className="secondary" onClick={startAnother}>
            Start another
          </button>
        </div>
        {submitError && <p className="error">{submitError}</p>}
      </form>

      {submitted && <StatusCard transaction={transaction} submitted={submitted} now={now} />}

      <form className="lookup" onSubmit={onLookup}>
        <h2>Check a payment</h2>
        <label>
          Transaction ID
          <input
            name="lookup_id"
            value={lookupId}
            onChange={(event) => setLookupId(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary">
          Look up
        </button>
        {lookupError && <p className="error">{lookupError}</p>}
        {lookup && (
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{lookup.status === "PROCESSED" ? "Completed" : "Processing"}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                {lookup.amount} {lookup.currency}
              </dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>{lookup.source_account}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{lookup.destination_account}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{formatWhen(lookup.created_at)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{formatWhen(lookup.processed_at)}</dd>
            </div>
          </dl>
        )}
      </form>

      <p className="api">Connected to {API_URL}</p>
    </main>
  );
}
