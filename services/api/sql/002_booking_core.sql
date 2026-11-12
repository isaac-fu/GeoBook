ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS properties (
  hotel_id TEXT PRIMARY KEY, owner_id UUID NOT NULL REFERENCES users(id),
  published BOOLEAN NOT NULL DEFAULT true, suspended BOOLEAN NOT NULL DEFAULT false, demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), hotel_id TEXT NOT NULL REFERENCES properties(hotel_id),
  name TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 30),
  nightly_cents INTEGER NOT NULL CHECK(nightly_cents BETWEEN 100 AND 10000000),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'), active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_hotel_idx ON rooms(hotel_id);
CREATE TABLE IF NOT EXISTS room_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), room_id UUID NOT NULL REFERENCES rooms(id),
  stay DATERANGE NOT NULL CHECK(NOT isempty(stay) AND NOT lower_inf(stay) AND NOT upper_inf(stay)),
  reason TEXT NOT NULL DEFAULT 'Unavailable'
);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS request_key UUID;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hotel_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS room_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS special_requests TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_request_key_idx ON bookings(user_id, request_key);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, hotel_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id, hotel_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
  user_id UUID NOT NULL REFERENCES users(id), hotel_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10), body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_hotel_idx ON reviews(hotel_id, created_at DESC);
CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_type TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id UUID NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id), message TEXT NOT NULL,
  booking_id UUID, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
