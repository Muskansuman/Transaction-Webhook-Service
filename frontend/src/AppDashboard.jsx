import { useEffect, useState } from "react";
import { API_URL, fetchHealth, fetchTransaction, submitTransaction } from "./api.js";
import { PROCESSING_SECONDS, formatWhen, secondsRemaining, toPayload, validateForm } from "./form.js";

const EMPTY_FORM = {
  transaction_id: "",
  source_account: "acc_user_789",
  destination_account: "acc_merchant_456",
  amount: "1500",
  currency: "INR",
};

function newTransactionId() {
  return `txn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function CheckCard({ number, title, state, value, detail }) {
  return (
    <article className={`check-card ${state}`}>
      <div className="check-heading">
        <span className="check-number">{number}</span>
        <span className="check-state">
          {state === "pass" ? "Passed" : state === "fail" ? "Needs attention" : "Watching"}
        </span>
      </div>
      <h3>{title}</h3>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function Verification({ submitted, transaction, deliveries, persisted, pollFailures, now }) {
  const complete = transaction?.status === "PROCESSED";
  const remaining = transaction?.created_at
    ? secondsRemaining(transaction.created_at, now)
    : PROCESSING_SECONDS;
  const duplicateCount = deliveries.filter((delivery) => delivery.result === "duplicate").length;
  const maxLatency = deliveries.length
    ? Math.max(...deliveries.map((delivery) => delivery.elapsedMs))
    : null;
  const allDeliveriesReturned = deliveries.length === 3;
  const elapsed =
    complete && transaction.processed_at
      ? Math.round(
          (Date.parse(transaction.processed_at) - Date.parse(transaction.created_at)) / 1000,
        )
      : null;

  return (
    <section className="verification" aria-live="polite">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Live success criteria</p>
          <h2>{complete ? "Verification complete" : "Verifying in real time"}</h2>
        </div>
        <span className={`run-status ${complete ? "complete" : ""}`}>
          <i />
          {complete ? "Finished" : "Processing"}
        </span>
      </div>

      <div className="checks">
        <CheckCard
          number="01"
          title="Single transaction"
          state={complete ? "pass" : "pending"}
          value={complete ? `Processed in ${elapsed}s` : `${remaining ?? "—"}s remaining`}
          detail={
            complete
              ? "The logical transaction reached PROCESSED after the background delay."
              : "The worker is handling one logical transaction in the background."
          }
        />
        <CheckCard
          number="02"
          title="Duplicate prevention"
          state={allDeliveriesReturned && duplicateCount >= 2 ? "pass" : "pending"}
          value={
            allDeliveriesReturned
              ? `${deliveries.length} deliveries → 1 record`
              : `${deliveries.length} of 3 deliveries acknowledged`
          }
          detail={
            allDeliveriesReturned && duplicateCount >= 2
              ? "Two repeated webhooks were identified as duplicates and did not create new work."
              : "Sending the same webhook three times to test the idempotency boundary."
          }
        />
        <CheckCard
          number="03"
          title="Fast acknowledgement"
          state={!allDeliveriesReturned ? "pending" : maxLatency < 500 ? "pass" : "fail"}
          value={maxLatency == null ? "Measuring…" : `${Math.round(maxLatency)}ms slowest`}
          detail="Acknowledgements are measured while processing is active. Target: under 500ms."
        />
        <CheckCard
          number="04"
          title="Reliable persistence"
          state={persisted ? "pass" : "pending"}
          value={persisted ? "Stored before completion" : "Confirming durable state…"}
          detail={
            pollFailures > 0
              ? `Status checks recovered from ${pollFailures} temporary error${pollFailures === 1 ? "" : "s"}.`
              : "The accepted transaction remains retrievable while the worker runs."
          }
        />
      </div>

      <div className="timeline">
        <div className="timeline-copy">
          <span className="pulse" />
          <div>
            <strong>{complete ? "Background processing finished" : "Background processing active"}</strong>
            <p>
              {complete
                ? `${submitted.transaction_id} completed at ${formatWhen(transaction.processed_at)}.`
                : `Polling ${submitted.transaction_id} every 2 seconds while the worker runs.`}
            </p>
          </div>
        </div>
        {!complete && (
          <div className="progress" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(
                  100,
                  ((PROCESSING_SECONDS - (remaining ?? PROCESSING_SECONDS)) / PROCESSING_SECONDS) *
                    100,
                )}%`,
              }}
            />
          </div>
        )}
      </div>

      {transaction && (
        <dl className="transaction-details">
          <div>
            <dt>Transaction</dt>
            <dd>{transaction.transaction_id}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`status-pill ${complete ? "done" : ""}`}>{transaction.status}</span>
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{transaction.amount} {transaction.currency}</dd>
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

export default function AppDashboard() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FORM, transaction_id: newTransactionId() });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [pollError, setPollError] = useState("");
  const [pollFailures, setPollFailures] = useState(0);
  const [submitted, setSubmitted] = useState(null);
  const [transaction, setTransaction] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [persisted, setPersisted] = useState(false);
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
          if (!cancelled) {
            setHealth(body);
            setHealthError("");
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setHealth(null);
            setHealthError(error.message);
          }
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
          setPersisted(true);
          setPollError("");
        }
      } catch (error) {
        if (!cancelled) {
          setPollError(error.message);
          setPollFailures((count) => count + 1);
        }
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
    setPollError("");
    setPollFailures(0);
    setSubmitted(null);
    setTransaction(null);
    setDeliveries([]);
    setPersisted(false);

    try {
      const first = await submitTransaction(payload);
      setDeliveries([first]);
      setSubmitted(payload);
      try {
        const repeats = await Promise.all([
          submitTransaction(payload),
          submitTransaction(payload),
        ]);
        setDeliveries([first, ...repeats]);
      } catch (error) {
        setSubmitError(`Duplicate check could not finish: ${error.message}`);
      }
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
    setDeliveries([]);
    setPersisted(false);
    setSubmitError("");
    setPollError("");
    setPollFailures(0);
  }

  return (
    <main>
      <nav>
        <div className="brand"><span>W</span> WebhookLab</div>
        <div className={`health-dot ${healthError ? "down" : ""}`}>
          <i />
          {health ? "Service healthy" : healthError ? "Service unavailable" : "Checking service"}
        </div>
      </nav>

      <header className="hero">
        <p className="eyebrow">Transaction verification console</p>
        <h1>Watch a webhook prove itself.</h1>
        <p className="lede">
          Send one logical transaction. The console delivers it three times, measures every
          acknowledgement, and watches the durable record through the {PROCESSING_SECONDS}-second job.
        </p>
      </header>

      <div className="workspace">
        <form className="composer" onSubmit={onSubmit} noValidate>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Test payload</p>
              <h2>New transaction</h2>
            </div>
            <span className="delivery-badge">3 deliveries</span>
          </div>

          <label>
            Transaction ID
            <input name="transaction_id" value={form.transaction_id} onChange={updateField} />
            {fieldErrors.transaction_id && <span className="error">{fieldErrors.transaction_id}</span>}
          </label>
          <div className="row">
            <label>
              Source account
              <input name="source_account" value={form.source_account} onChange={updateField} />
              {fieldErrors.source_account && <span className="error">{fieldErrors.source_account}</span>}
            </label>
            <label>
              Destination account
              <input name="destination_account" value={form.destination_account} onChange={updateField} />
              {fieldErrors.destination_account && <span className="error">{fieldErrors.destination_account}</span>}
            </label>
          </div>
          <div className="row amount-row">
            <label>
              Amount
              <input name="amount" inputMode="decimal" value={form.amount} onChange={updateField} />
              {fieldErrors.amount && <span className="error">{fieldErrors.amount}</span>}
            </label>
            <label>
              Currency
              <input name="currency" value={form.currency} onChange={updateField} maxLength={3} />
              {fieldErrors.currency && <span className="error">{fieldErrors.currency}</span>}
            </label>
          </div>
          <p className="form-note">
            The first delivery creates the record. Two concurrent repeats verify deduplication while
            processing is active.
          </p>
          <div className="actions">
            <button type="submit" disabled={submitting || Boolean(healthError)}>
              {submitting ? "Starting verification…" : "Send & verify"}
            </button>
            <button type="button" className="secondary" onClick={startAnother}>
              New payload
            </button>
          </div>
          {submitError && <p className="error">{submitError}</p>}
          {pollError && <p className="warning">Status temporarily unavailable; retrying automatically.</p>}
        </form>

        {!submitted ? (
          <section className="empty-state">
            <div className="empty-icon">↗</div>
            <h2>Ready for a live run</h2>
            <p>The four success criteria will appear here as soon as the webhook is accepted.</p>
            <ol>
              <li><span>01</span> 30-second background completion</li>
              <li><span>02</span> Duplicate suppression</li>
              <li><span>03</span> Sub-500ms acknowledgement</li>
              <li><span>04</span> Durable, recoverable state</li>
            </ol>
          </section>
        ) : (
          <Verification
            submitted={submitted}
            transaction={transaction}
            deliveries={deliveries}
            persisted={persisted}
            pollFailures={pollFailures}
            now={now}
          />
        )}
      </div>

      <footer>
        <span>API endpoint</span>
        <code>{API_URL}</code>
      </footer>
    </main>
  );
}
