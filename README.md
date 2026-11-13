# GeoBook

Hotel discovery and demo reservations with separate guest, hotel-operator, and admin frontends. Ordinary destination search and booking work without Mapbox; travel-time search uses isochrone polygons and route matrices.

## Docker setup

Copy `.env.example` to the root `.env` if you do not already have one; preserve existing configuration. From `infra`:

```powershell
docker compose --env-file ../.env up --build -d
```

| App | URL |
| --- | --- |
| Guest | http://localhost:8080 |
| Hotel operator | http://localhost:8081 |
| Admin | http://localhost:8082 |
| API readiness | http://localhost:4000/api/health/ready |
| Local email inbox | http://localhost:8025 |

Docker installs and builds all frontend, API, and worker dependencies. Nginx provides same-origin API proxying. MongoDB, PostgreSQL/PostGIS, and Kafka use health checks. Kafka uses KRaft, without ZooKeeper. API startup automatically applies additive SQL migrations to existing databases. Keep existing volumes; do not remove them to update the schema.

GeoBook defaults to host port 5433 to coexist with another PostgreSQL installation on 5432. `POSTGRES_PORT` controls this mapping. Containers still connect to `postgres:5432`; host-run Node processes use port 5433 in `DATABASE_URL`. Password-authentication errors mean the configured credentials do not match the instance being reached. Changing Compose's initial password does not reset an existing database volume's password.

Set `MAPBOX_TOKEN` in the root `.env` and recreate the API for live travel estimates. The token stays on the server.

## Try the complete demo

1. Register a guest account, open a featured demo property, and select future dates and guests.
2. Check availability, select a room, and review the server-calculated total.
3. Confirm the explicitly labeled demo reservation. No payment or actual accommodation is involved.
4. Open **My bookings** to view or cancel it before check-in. **Updates** shows Kafka-delivered booking/cancellation notifications.
5. Save favorite hotels and manage your name/password under your account.

Startup seeds **Demo Harbor House** (San Francisco) and **Demo Park House** (New York), each with three physical rooms. Reseeding is idempotent. Imported real OSM hotels remain discovery-only without connected supplier inventory.

On port 8081, register an operator account, create a property, and add rooms with capacity and rates. Edit descriptions, amenities, attributed/licensed photo URLs, publication status, room availability blocks, and rates; view your reservations. Each inventory row represents one physical room, not a room-type allocation. Set a room type (for example, King suite), then edit the room to add up to ten optional rate plans with a nightly supplement, breakfast inclusion, and minimum stay. Room only remains available at the base rate; all demo plans retain free cancellation before check-in. Operator-created inventory is also demo inventory.

To manage the built-in properties, optionally set `DEMO_PASSWORD` (at least 12 characters) **before their first seed**, then sign in as `demo.owner@geobook.test`. Reseeding never resets an existing account's password. Otherwise, register your own operator account and create your own property.

Admin registration is not public. After API startup, from `infra` in PowerShell:

```powershell
$env:ADMIN_EMAIL = Read-Host 'Administrator email'
$adminSecret = Read-Host 'Administrator password (at least 12 characters)' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminSecret).Password
docker compose exec -e ADMIN_EMAIL -e ADMIN_PASSWORD api npx tsx scripts/bootstrap-admin.ts
Remove-Item Env:ADMIN_PASSWORD
Remove-Item Env:ADMIN_EMAIL
```

An existing account must supply its matching password before promotion. The admin portal shows users, booking totals, pending events, and property moderation. Operators cannot override admin suspensions.

## Implemented core

- Destination search across name, city, province/state, and country; pagination, price sorting/filtering, and date/guest availability filtering.
- Hotel profiles, descriptions, amenities, licensed photo attribution, verified-stay reviews, favorites, and checkout.
- Registration/login/logout, salted scrypt password hashes, hashed server-side sessions, HttpOnly cookies, request-origin checks, password rotation, and role/ownership checks.
- Transactional bookings with server-calculated prices, room locking, a PostgreSQL overlap exclusion constraint, idempotency keys, and cancellation.
- Room type labels and per-room rate plans with breakfast, minimum stays, server-calculated supplements, and immutable booked plan details. Plans share the physical room’s inventory.
- Email verification and password recovery with hashed, expiring single-use tokens, resend cooldowns, and session revocation on password reset.
- One review per completed confirmed stay.
- Transactional outbox → Kafka → persistent in-app notifications with duplicate-event protection.
- Separate guest, operator, and admin applications.

MongoDB stores hotel content and geography. PostgreSQL stores accounts, sessions, rooms, blocks, bookings, favorites, reviews, notifications, and outbox events.

This is a local development MVP. Bookings and prices are demo data; live payment processing, taxes, supplier settlement, and outbound booking email/SMS are not implemented. Optional Stripe sandbox checkout is available for testing. Account verification and password recovery use SMTP with a local Mailpit inbox in Compose. Production needs managed secrets, HTTPS/secure cookies, restricted database access, and durable operations. Compose uses local HTTP and development credentials.

## Hotel catalog

Bundled OSM location files contain 146 records: Midtown Manhattan (60), San Francisco (20), Los Angeles (20), San Diego (20), Buffalo (18), and Albany (8). These are central-city samples, not statewide coverage. From `infra`:

```powershell
docker compose exec api node --experimental-strip-types scripts/import-hotels.ts data/osm-midtown.json --apply
docker compose exec api node --experimental-strip-types scripts/import-hotels.ts data/osm-california-new-york.json --apply
docker compose exec api node --experimental-strip-types scripts/verify-catalog.ts
```

Existing IDs are skipped to preserve edits. Omit `--apply` for validation only. Imports are explicit maintenance tasks, never startup or guest-search side effects. Search city names, “California”, or “New York” after import.

Fresh region samples support `--osm-region=san-francisco`, `los-angeles`, `san-diego`, `buffalo`, `albany`, and `midtown`. `OVERPASS_URL` selects an optional public query server; servers can be temporarily unavailable. For host-run commands, prefix script/data paths with `services/api/`.

Schemas validate geography, coordinates, nullable rates, descriptions, ratings with provider attribution, amenities, licensed images, and provenance. MongoDB has a 2dsphere index. OSM supplies locations, not live rates, inventory, photographs, or reviews; missing content is labeled. Preserve catalog NOTICE files and attribution to © OpenStreetMap contributors under [ODbL](https://www.openstreetmap.org/copyright). Separate OSM elements may describe the same physical property and require reconciliation.

## Travel UI

Open **Explore travel times** on a hotel profile. The map supports anchor selection, coordinates, budgets, walking/cycling/driving modes, any/all matching, distance/time ranking, and nested shaded isochrone polygons with minute labels. Layer toggles do not request new routes. Changing criteria clears stale results. Enable unpriced hotels to include OSM listings. Live estimates require Mapbox and are never fabricated.

## Travel search (implemented API slice)

`POST /api/hotels/travel-search` accepts:

```json
{
  "anchor": [-73.9857, 40.7484],
  "modes": ["walking", "cycling", "driving"],
  "direction": "from-anchor",
  "ringsMinutes": [15, 30, 45],
  "maxMinutes": 45,
  "maxDistanceMeters": 20000,
  "match": "any",
  "sortBy": "duration",
  "minPrice": 0,
  "maxPrice": 300,
  "limit": 20
}
```

Coordinates use longitude, latitude. `from-anchor` means anchor → hotel; the default `to-anchor` means hotel → anchor. Rings must increase, contain at most four values, and end at maxMinutes (up to 60). They are reachable-area polygons, not circular distance buffers.

The API returns GeoJSON contours per mode, each hotel's duration in seconds and distance in meters per mode, bestMode, score, and search metadata. `any` accepts a hotel if one selected mode meets both budgets; `all` requires every selected mode to meet both. The best eligible mode supplies the score in either case. Distance sorting uses distance along the provider's fastest route, not the shortest possible route. Unreachable routes remain null and cannot qualify a hotel.

Outbound searches prefilter MongoDB hotel GeoJSON points with the outer contour using a 2dsphere index, then calculate matrix estimates in batches of 24 hotels plus the anchor. Contours are approximate: this mode ranks the candidates admitted by those polygons. Inbound searches do not use outbound contours to exclude hotels, because route direction matters; returned contours are explicitly labeled outbound context. Matrix results enforce the final budgets.

This first slice limits searches to 120 candidates and two concurrent requests per API process. Larger searches return 422 rather than silently ranking an arbitrary subset. Production work includes shared rate limits, a provider-policy-compliant cache, stronger candidate discovery for inbound searches, availability filters, and availability integration. Public transit, combined transport legs, departure-time traffic, and multiple destinations are future provider/UI work. No live routing data is mocked as real estimates.

Hotel documents require `priceFrom` and `location: { type: "Point", coordinates: [longitude, latitude] }`. Set MAPBOX_TOKEN in the environment (Compose passes it through); credentials stay on the server. Run `npm install`, `npm --workspace services/api run build`, and `npm --workspace services/api test`.

## Development and checks

Use Node 22+ and the root workspace lockfile:

```powershell
npm ci
npm run build
npm --workspace services/api test
node --env-file=.env --import tsx services/api/src/server.ts
```

Run `npm run dev:guest`, `npm run dev:hotel`, and `npm run dev:admin` in separate terminals (ports 5173–5175). Vite proxies to port 4000; `API_PROXY_TARGET` overrides this. Run the built worker with `node --env-file=.env services/worker/dist/worker.js`.

After building, integration checks create random PostgreSQL schemas and MongoDB databases and clean up their own data:

```powershell
node --env-file=.env services/api/test/integration.cjs
node --env-file=.env services/api/test/notifications.cjs
```

The first requires PostgreSQL and MongoDB and tests migration reruns, authentication, ownership, an eight-request booking race, idempotency, cancellation, availability blocks, rate-plan pricing/minimum stays/shared inventory, booked-term snapshots, reviews, moderation, password rotation, verification links, recovery expiry/replay, concurrent password resets, and sandbox payment creation/webhooks/refunds. The second also requires Kafka and a built worker; it verifies outbox delivery and duplicate handling with an isolated topic/group. Use a local development database account with schema creation permission, never production.

## Optional Stripe sandbox checkout

After confirming a demo reservation, open **My bookings → Open Stripe test checkout**. Payment is an optional test on an already-confirmed reservation; it does not reserve real accommodation or gate demo inventory. Only test-mode card payments are supported. Payment status is separate from reservation status, and returning from Stripe does not itself mark a payment successful.

1. Set `STRIPE_SECRET_KEY` to a Stripe sandbox `sk_test_...` key. Live keys are rejected at startup.
2. Forward sandbox events with the Stripe CLI:

   ```powershell
   stripe listen --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded --forward-to localhost:4000/api/payments/webhook
   ```

3. Set `STRIPE_WEBHOOK_SECRET` to the listener's signing secret and restart/recreate the API. Keep both credentials server-side. `PUBLIC_APP_URL` controls the return destination (port 8080 for Docker, 5173 for Vite).
4. Create a future demo reservation, open checkout, and use [Stripe's documented test payment details](https://docs.stripe.com/testing). Return to My bookings and refresh the payment status after webhook delivery.
5. Cancel the reservation before check-in to close open checkout or refund the test payment. If Stripe is unavailable or the refund is pending/failed, cancellation leaves the reservation intact and can be retried.

The API charges the saved server-calculated total, verifies raw-body webhook signatures, checks reservation/amount/currency/test mode, and retrieves current provider state to handle duplicate and reordered events. Checkout creation and refunds use stable idempotency keys. A persisted checkout intent recovers a lost creation response; if it remains unresolved for 23 hours, further attempts require operator reconciliation rather than risking a duplicate charge. One checkout is allowed per reservation. Expired checkout does not cancel the demo reservation; cancel and create another reservation to repeat the test. Totals above 99,999,999 cents are rejected.

Sandbox checkout is disabled without credentials. Integration tests use an injected fake provider and signed test webhooks; they exercise lost responses, concurrent creation, mismatched amounts, invalid signatures, refunds, and cancellation failures without contacting Stripe. Hosted checkout still requires a manual sandbox run with your credentials. Durable reconciliation jobs, dashboard-initiated refund synchronization, payment-required inventory holds, taxes, and production payments remain future work.

Provider references: [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment), [webhook verification](https://docs.stripe.com/events/manage-webhook-endpoints), and [refunds](https://docs.stripe.com/api/refunds/create).

## Account email and password recovery

Compose captures account emails in [Mailpit](http://localhost:8025); messages are not delivered to external inboxes. After registration, open **Your account → Send verification email**, open the captured message, and confirm the link. Verification records email ownership but does not yet gate demo bookings or operator access. Existing accounts remain usable and initially show unverified.

Use **Forgot password?** in the sign-in dialog, then open the reset link and choose a password of at least 12 characters. Reset links expire after 30 minutes; verification links expire after 24 hours. Both are single-use, and resending after the one-minute cooldown replaces the previous link of that kind. Password reset signs out every existing session. A normal password change also invalidates outstanding reset links.

For host-run development, configure SMTP using the entries in `.env.example` and set `PUBLIC_APP_URL=http://localhost:5173/`. Docker defaults to the guest portal on port 8080. Links use this configured address, never a browser-supplied host; all three portals support the link pages. Host SMTP defaults to localhost:1025. External SMTP can be configured for a host-run API with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM`; Compose deliberately routes to Mailpit.

Recovery returns a generic 202 response before looking up the account or delivering mail. Delivery runs in the API process; it is not a durable job queue, and requests interrupted by a restart must be retried. SMTP failures invalidate the undelivered token and log a generic error without credentials or links. Per-IP limits are process-local; production needs shared limits and durable delivery. API tests inject an in-memory mail capture so they never send external email.

Implementation references: [Nodemailer SMTP](https://nodemailer.com/smtp) and [Mailpit Docker setup](https://mailpit.axllent.org/docs/install/docker/).

## Room rates API

Operator room create/update requests accept `roomType` and `ratePlans` (up to ten entries). Each plan has a stable UUID `id`, `name`, integer `additionalNightlyCents` (0–10,000,000), `breakfastIncluded`, and `minNights` (1–90). Updating a room replaces its plan list. The base room-only plan always has ID `standard`.

Availability returns eligible `rates` for each room, with `nightlyCents` and `totalCents`. Send the chosen `ratePlanId` and `expectedTotalCents` when booking; omitting the plan selects `standard` for compatibility. The API checks the plan and price while holding the room lock. Bookings preserve room type, plan name, breakfast, and total even after an operator changes or removes the plan. Existing rooms/bookings receive standard defaults through additive migration `003_room_rates.sql`.

## Next milestones

Stripe sandbox checkout, verification/recovery email, and supplemental room rate plans are implemented. Further extensions: payment-required inventory holds, durable payment/email reconciliation, shared rate limits, pooled room-type inventory, seasonal pricing, and different cancellation policies.
1. Elasticsearch autocomplete, typo tolerance, facets, and natural-language intent parsing.
2. Availability-aware travel search, larger candidate discovery, caching, and supported transit/combined-mode routing.

Current travel modes are evaluated separately; they are not combined walking-plus-transit journeys.

