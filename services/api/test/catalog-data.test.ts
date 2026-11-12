import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHotels } from '../src/hotel-model.ts';
import { catalogRegions } from '../src/catalog-regions.ts';
test('expanded catalog is valid, geographically bounded and disjoint from Midtown', () => {
  const expanded = validateHotels(JSON.parse(readFileSync(new URL('../data/osm-california-new-york.json', import.meta.url), 'utf8')));
  const midtown = validateHotels(JSON.parse(readFileSync(new URL('../data/osm-midtown.json', import.meta.url), 'utf8')));
  assert.equal(expanded.length, 86);
  assert.equal(new Set([...expanded, ...midtown].map(r => r._id)).size, expanded.length + midtown.length);
  for (const hotel of expanded) {
    const region = Object.values(catalogRegions).find(r => r.city === hotel.city && r.province === hotel.province);
    assert.ok(region);
    const [lng, lat] = hotel.location.coordinates;
    assert.ok(lat >= region.bbox[0] && lng >= region.bbox[1] && lat <= region.bbox[2] && lng <= region.bbox[3]);
    assert.equal(hotel.priceFrom, null);
    assert.equal(hotel.synthetic, false);
    assert.equal(hotel.source.license, 'ODbL-1.0');
  }
});
