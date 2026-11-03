import { errorMessage } from "./form.js";

function apiUrl() {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host && host !== "localhost" && host !== "127.0.0.1") {
      return window.location.origin;
    }
  }
  const configured = import.meta.env.VITE_API_URL;
  if (configured) {
    return String(configured).replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

export const API_URL = apiUrl();

export async function fetchHealth() {
  const response = await fetch(`${API_URL}/`);
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return response.json();
}

export async function submitTransaction(payload) {
  const startedAt = performance.now();
  const response = await fetch(`${API_URL}/v1/webhooks/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const elapsedMs = performance.now() - startedAt;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body, response.status));
  }
  return {
    body,
    elapsedMs,
    result: response.headers.get("X-Webhook-Result") || "accepted",
  };
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
