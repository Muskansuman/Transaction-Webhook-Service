from decimal import Decimal

from pydantic import BaseModel, Field, field_serializer, field_validator


class WebhookRequest(BaseModel):
    transaction_id: str = Field(min_length=1, max_length=128)
    source_account: str = Field(min_length=1, max_length=128)
    destination_account: str = Field(min_length=1, max_length=128)
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)
    currency: str = Field(min_length=3, max_length=3)

    @field_validator("transaction_id", "source_account", "destination_account")
    @classmethod
    def strip_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        normalized = value.strip().upper()
        if len(normalized) != 3 or not normalized.isalpha():
            raise ValueError("currency must be a 3-letter code")
        return normalized


class TransactionResponse(BaseModel):
    transaction_id: str
    source_account: str
    destination_account: str
    amount: Decimal
    currency: str
    status: str
    created_at: str
    processed_at: str | None

    @field_serializer("amount")
    def serialize_amount(self, value: Decimal) -> int | float:
        if value == value.to_integral():
            return int(value)
        return float(value)
