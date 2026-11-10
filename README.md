# GeoBook

GeoBook focuses on finding hotels by travel time and route distance to the places guests care about. Walking, cycling, and driving are evaluated separately; hotels are ranked using Mapbox matrix estimates.

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

This first slice limits searches to 120 candidates and two concurrent requests per API process. Larger searches return 422 rather than silently ranking an arbitrary subset. Production work includes shared rate limits, a provider-policy-compliant cache, stronger candidate discovery for inbound searches, availability filters, and the map UI. Public transit, combined transport legs, departure-time traffic, and multiple destinations are future provider/UI work. No live routing data is mocked as real estimates.

Hotel documents require `priceFrom` and `location: { type: "Point", coordinates: [longitude, latitude] }`. Set MAPBOX_TOKEN in the environment (Compose passes it through); credentials stay on the server. Run `npm install`, `npm --workspace services/api run build`, and `npm --workspace services/api test`.

## Planned product architecture

- `apps/guest-web` — guest search, map results, hotel details, and booking flow.
- `apps/hotel-web` — inventory, availability, and reservation management for properties.
- `apps/admin-web` — operational metrics, event health, and platform administration.
- `services/api` — Node/Express API. MongoDB stores hotel/property documents; PostgreSQL stores users, rooms, and bookings.
- `services/worker` — Kafka consumer for notifications, search-index refreshes, and analytics events.
- `infra/docker-compose.yml` — MongoDB, PostgreSQL/PostGIS, Kafka, Zookeeper, and the API worker stack.

## Local development

```bash
docker compose -f infra/docker-compose.yml up --build
```

The API is available at `http://localhost:4000/health`. The three frontend applications are planned and have not been scaffolded yet. Authentication and notification delivery also remain unfinished.

```bash
npm install
npm run dev:api
```

Copy `.env.example` to `.env` for local configuration. The API intentionally keeps hotel documents in MongoDB while booking state lives in PostgreSQL so reservation conflicts can be protected with a database transaction and an exclusion constraint.

