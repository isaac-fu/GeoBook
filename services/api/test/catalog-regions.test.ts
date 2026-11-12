import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogRegions } from '../src/catalog-regions.ts';
test('catalog regions use ordered geographic bounds and correct states', () => {
  for (const region of Object.values(catalogRegions)) {
    const [south, west, north, east] = region.bbox;
    assert.ok(south < north && west < east);
    assert.ok(south >= -90 && north <= 90 && west >= -180 && east <= 180);
    assert.ok(region.limit > 0 && region.limit <= 60);
  }
  for (const name of ['san-francisco', 'los-angeles', 'san-diego'] as const) assert.equal(catalogRegions[name].province, 'California');
  for (const name of ['midtown', 'buffalo', 'albany'] as const) assert.equal(catalogRegions[name].province, 'New York');
});
