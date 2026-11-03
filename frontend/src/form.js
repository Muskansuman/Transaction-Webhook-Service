export const PROCESSING_SECONDS = 30;

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export function validateForm(form) {
  const errors = {};
  const transactionId = String(form.transaction_id ?? "").trim();
  const source = String(form.source_account ?? "").trim();
  const destination = String(form.destination_account ?? "").trim();
  const currency = String(form.currency ?? "").trim();
  const amountText = String(form.amount ?? "").trim();

  if (!transactionId) errors.transaction_id = "Enter a transaction ID.";
  else if (transactionId.length > 128) errors.transaction_id = "Use 128 characters or fewer.";

  if (!source) errors.source_account = "Enter the account the money comes from.";
  else if (source.length > 128) errors.source_account = "Use 128 characters or fewer.";

  if (!destination) errors.destination_account = "Enter the account that receives the money.";
  else if (destination.length > 128) errors.destination_account = "Use 128 characters or fewer.";

  if (!amountText) errors.amount = "Enter an amount greater than 0.";
  else if (!AMOUNT_PATTERN.test(amountText) || Number(amountText) <= 0) {
    errors.amount = "Use a number greater than 0 with at most 2 decimal places.";
  } else if (amountText.replace(".", "").length > 18) {
    errors.amount = "Amount is too large.";
  }

  if (!/^[A-Za-z]{3}$/.test(currency)) {
    errors.currency = "Use a 3-letter currency code, such as INR.";
  }

  return errors;
}

export function toPayload(form) {
  return {
    transaction_id: String(form.transaction_id).trim(),
    source_account: String(form.source_account).trim(),
    destination_account: String(form.destination_account).trim(),
    amount: Number(String(form.amount).trim()),
    currency: String(form.currency).trim().toUpperCase(),
  };
}

export function storedPaymentDiffers(submitted, stored) {
  if (!stored) return false;
  return (
    Number(submitted.amount) !== Number(stored.amount) ||
    submitted.source_account !== stored.source_account ||
    submitted.destination_account !== stored.destination_account ||
    submitted.currency !== stored.currency
  );
}

export function secondsRemaining(createdAt, nowMs, delaySeconds = PROCESSING_SECONDS) {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.ceil(delaySeconds - (nowMs - created) / 1000));
}

export function formatWhen(iso) {
  if (!iso) return "Not finished yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function errorMessage(body, status) {
  const detail = body?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((item) => (typeof item?.msg === "string" ? item.msg : "Invalid value"))
      .join(" ");
  }
  if (status === 404) return "No transaction exists with that ID.";
  if (status === 503) return "The service could not store this payment. Try again.";
  return `Request failed (${status})`;
}
