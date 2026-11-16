-- Commit receipts with payment updates: failed processing must remain retryable.
CREATE TABLE IF NOT EXISTS payment_webhook_receipts (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
