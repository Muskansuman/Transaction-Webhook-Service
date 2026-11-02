import { errorMessage } from "./form.js";

export const API_URL =
  import.meta.env.VITE_API_URL || "http://130.210.26.235:8000";

export async function fetchHealth() {
  const response = await fetch(`${API_URL}/`);
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return response.json();
}

export async function submitTransaction(payload) {
  const response = await fetch(`${API_URL}/v1/webhooks/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body, response.status));
  }
  return body;
}

export async function fetchTransaction(transactionId) {
  const response = await fetch(
    `${API_URL}/v1/transactions/${encodeURIComponent(transactionId)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(errorMessage(body, response.status));
  }
  const rows = await response.json();
  return rows[0] ?? null;
}
