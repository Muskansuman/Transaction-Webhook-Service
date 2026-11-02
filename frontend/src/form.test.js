import { describe, expect, it } from "vitest";
import {
  errorMessage,
  secondsRemaining,
  storedPaymentDiffers,
  toPayload,
  validateForm,
} from "./form.js";

const valid = {
  transaction_id: "txn_1",
  source_account: "acc_user_789",
  destination_account: "acc_merchant_456",
  amount: "1500",
  currency: "inr",
};

describe("validateForm", () => {
  it("accepts a normal payment and trims it into the API payload", () => {
    expect(validateForm(valid)).toEqual({});
    expect(
      toPayload({
        ...valid,
        transaction_id: "  txn_1  ",
        currency: " inr ",
        amount: "1500.50",
      }),
    ).toEqual({
      transaction_id: "txn_1",
      source_account: "acc_user_789",
      destination_account: "acc_merchant_456",
      amount: 1500.5,
      currency: "INR",
    });
  });

  it("rejects blank fields, including values that are only spaces", () => {
    const errors = validateForm({
      transaction_id: "   ",
      source_account: "",
      destination_account: " ",
      amount: "",
      currency: "",
    });
    expect(errors.transaction_id).toBeTruthy();
    expect(errors.source_account).toBeTruthy();
    expect(errors.destination_account).toBeTruthy();
    expect(errors.amount).toBeTruthy();
    expect(errors.currency).toBeTruthy();
  });

  it("rejects amounts that are zero, negative, or have more than 2 decimal places", () => {
    for (const amount of ["0", "0.00", "-5", "1.234", "1,500", "1e2", "abc"]) {
      expect(validateForm({ ...valid, amount }).amount, amount).toBeTruthy();
    }
  });

  it("rejects currency codes that are not 3 letters", () => {
    for (const currency of ["IN", "INRX", "12A", "₹"]) {
      expect(validateForm({ ...valid, currency }).currency, currency).toBeTruthy();
    }
  });

  it("rejects ids and accounts longer than 128 characters", () => {
    const long = "a".repeat(129);
    const errors = validateForm({
      ...valid,
      transaction_id: long,
      source_account: long,
      destination_account: long,
    });
    expect(errors.transaction_id).toBeTruthy();
    expect(errors.source_account).toBeTruthy();
    expect(errors.destination_account).toBeTruthy();
  });

  it("allows the same source and destination account", () => {
    expect(
      validateForm({
        ...valid,
        source_account: "acc_same",
        destination_account: "acc_same",
      }),
    ).toEqual({});
  });
});

describe("stored payment comparison", () => {
  const submitted = toPayload(valid);

  it("treats a matching stored row as the same payment", () => {
    expect(
      storedPaymentDiffers(submitted, {
        ...submitted,
        amount: 1500,
        currency: "INR",
      }),
    ).toBe(false);
  });

  it("detects when a repeated id kept the original amount or accounts", () => {
    expect(storedPaymentDiffers(submitted, { ...submitted, amount: 10 })).toBe(true);
    expect(
      storedPaymentDiffers(submitted, { ...submitted, destination_account: "acc_other" }),
    ).toBe(true);
  });
});

describe("processing countdown", () => {
  const created = "2026-11-02T19:15:37Z";
  const createdMs = Date.parse(created);

  it("counts down from the 30 second processing window", () => {
    expect(secondsRemaining(created, createdMs)).toBe(30);
    expect(secondsRemaining(created, createdMs + 10_000)).toBe(20);
  });

  it("reaches zero when the wait is over and ignores a bad timestamp", () => {
    expect(secondsRemaining(created, createdMs + 31_000)).toBe(0);
    expect(secondsRemaining("not-a-date", createdMs)).toBeNull();
  });
});

describe("errorMessage", () => {
  it("reads string and validation-list errors from the API", () => {
    expect(errorMessage({ detail: "storage unavailable" }, 503)).toBe("storage unavailable");
    expect(
      errorMessage({ detail: [{ msg: "Field required" }, { msg: "Input should be greater than 0" }] }, 422),
    ).toBe("Field required Input should be greater than 0");
  });

  it("uses plain language for a missing transaction and a storage failure", () => {
    expect(errorMessage({}, 404)).toBe("No transaction exists with that ID.");
    expect(errorMessage({}, 503)).toBe("The service could not store this payment. Try again.");
  });
});
