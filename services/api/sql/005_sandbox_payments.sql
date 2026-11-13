CREATE TABLE IF NOT EXISTS sandbox_payments (
  booking_id UUID PRIMARY KEY REFERENCES bookings(id),
  session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
