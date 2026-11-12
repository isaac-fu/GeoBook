import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHotels } from '../src/hotel-model.ts';
const hotel = { _id: 'test:1', name: 'Test Hotel', city: 'New York', province: 'New York', country: 'United States', countryCode: 'US',
  location: { type: 'Point', coordinates: [-73.98, 40.75] }, priceFrom: null, currency: null,
  source: { provider: 'fixture', id: '1', url: 'https://example.com/1', license: 'CC0', attribution: 'Test fixture', fetchedAt: '2026-11-10T00:00:00.000Z' } };
test('unknown rates remain null and optional catalog arrays default empty', () => {
  const [record] = validateHotels([hotel]);
  assert.equal(record.priceFrom, null);
  assert.deepEqual(record.roomReferences, []);
});
test('invalid coordinates, missing provenance and priced records without currency fail', () => {
  assert.throws(() => validateHotels([{ ...hotel, location: { type: 'Point', coordinates: [190, 40] } }]));
  assert.throws(() => validateHotels([{ ...hotel, source: undefined }]));
  assert.throws(() => validateHotels([{ ...hotel, priceFrom: 100 }]));
  assert.throws(() => validateHotels([hotel, hotel]));
});
