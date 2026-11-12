# Midtown hotel catalog

## California and New York expansion

`osm-california-new-york.json` adds 86 records retrieved on 2026-11-11 via the North America Overpass mirror at https://ovp.dresel.systems/api-na/interpreter:

| City | State | Records |
| --- | --- | ---: |
| San Francisco | California | 20 |
| Los Angeles | California | 20 |
| San Diego | California | 20 |
| Buffalo | New York | 18 |
| Albany | New York | 8 |

These are central-city samples using the explicit bounding boxes in `src/catalog-regions.ts`, not complete city or state inventories. City/state are assigned from those boxes. Elements whose returned center falls outside their box are excluded. The attribution, ODbL license, unknown-rate caveat, and source-coordinate limitations below apply to both files.

`osm-midtown.json` contains 60 hotel location records derived from OpenStreetMap via Overpass on 2026-11-10, within latitude 40.740–40.760 and longitude -74.000–-73.970 (Midtown Manhattan). This is a limited sample, not an exhaustive catalog. City/province/country were assigned from this bounding box; point coordinates for ways/relations are the provider's centers, not verified entrances.

© OpenStreetMap contributors. Database licensed under the Open Data Commons Open Database License (ODbL) 1.0:

- https://www.openstreetmap.org/copyright
- https://opendatacommons.org/licenses/odbl/1-0/

Each record retains its source element URL and retrieval time. Preserve this attribution and license information with redistribution. Rate, availability, image, amenity, and room-inventory information has not been supplied; null/empty fields mean unknown. Separate OSM elements can describe the same physical hotel.
