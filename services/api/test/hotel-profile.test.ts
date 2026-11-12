import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staySchema } from '../src/hotel-profile.ts';
import { hotelSchema } from '../src/hotel-model.ts';
import { readFileSync } from 'node:fs';
test('availability requests reject invalid calendar dates, backwards stays and invalid guest counts', () => {
  assert.ok(staySchema.safeParse({ checkIn: '2027-02-01', checkOut: '2027-02-03', guests: '2' }).success);
  for (const input of [
    { checkIn: '2027-02-30', checkOut: '2027-03-03', guests: 2 },
    { checkIn: '2027-02-03', checkOut: '2027-02-01', guests: 2 },
    { checkIn: '2027-02-01', checkOut: '2027-02-01', guests: 2 },
    { checkIn: '2027-02-01', checkOut: '2027-02-03', guests: 0 },
  ]) assert.equal(staySchema.safeParse(input).success, false);
});
test('existing catalog remains compatible and ratings require valid score and provenance', () => {
  const hotel = JSON.parse(readFileSync(new URL('../data/osm-midtown.json', import.meta.url), 'utf8'))[0];
  assert.equal(hotelSchema.parse(hotel).rating, null);
  assert.equal(hotelSchema.parse(hotel).description, null);
  assert.equal(hotelSchema.safeParse({ ...hotel, rating: { score: 11, scale: 10, reviewCount: 12, provider: 'Test' } }).success, false);
  assert.ok(hotelSchema.safeParse({ ...hotel, rating: { score: 8.5, scale: 10, reviewCount: 12, provider: 'Test' } }).success);
});
