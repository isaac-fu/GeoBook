import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotelSearchFilter } from '../src/hotel-search.ts';
function matches(query: string, hotel: Record<string, string>) {
  return hotelSearchFilter(query).$and.every(term => term.$or.some(clause => {
    const [field, value] = Object.entries(clause)[0];
    return new RegExp(value.$regex, value.$options).test(hotel[field] ?? '');
  }));
}
test('searches geographic fields and combines words across fields', () => {
  assert.ok(matches('ontario canada', { province: 'Ontario', country: 'Canada' }));
  assert.ok(matches('new york', { city: 'New York' }));
  assert.ok(matches('Garden', { name: 'Garden Hotel' }));
  assert.equal(matches('ontario canada', { country: 'Canada', province: 'Quebec' }), false);
});
test('regex characters are treated literally', () => {
  assert.ok(matches('A+B', { name: 'A+B Hotel' }));
  assert.equal(matches('.*', { name: 'Any Hotel' }), false);
  assert.ok(matches('[Park]', { name: '[Park] Hotel' }));
});
