import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomRates, roomSchema } from '../src/room-rates.ts';

const plan = { id: 'ad330a55-b810-4b84-8a9c-29473005798c', name: 'Breakfast stay', additionalNightlyCents: 2500, breakfastIncluded: true, minNights: 3 };
test('legacy rooms retain the base rate and room type', () => {
  const room = roomSchema.parse({ name: '101', capacity: 2, nightlyCents: 10000 });
  assert.equal(room.roomType, 'Standard');
  assert.deepEqual(room.ratePlans, []);
  assert.equal(roomRates({ nightly_cents: 10000 }, 2)[0].totalCents, 20000);
});
test('rates enforce minimum nights and compute supplements for the whole stay', () => {
  const room = { nightly_cents: 10000, rate_plans: [plan] };
  assert.equal(roomRates(room, 2).length, 1);
  const rates = roomRates(room, 3);
  assert.equal(rates[0].totalCents, 30000);
  assert.equal(rates[1].totalCents, 37500);
  assert.equal(rates[1].breakfastIncluded, true);
  assert.equal(roomRates({ ...room, rate_plans: [] }, 3).some(r => r.id === plan.id), false);
});
test('rejects duplicate identifiers, invalid supplements and minimum stays', () => {
  const room = { name: '101', capacity: 2, nightlyCents: 10000, roomType: 'King suite' };
  for (const ratePlans of [[plan, plan], [{ ...plan, additionalNightlyCents: -1 }], [{ ...plan, minNights: 0 }], [{ ...plan, minNights: 91 }], [{ ...plan, additionalNightlyCents: 1.5 }]]) {
    assert.equal(roomSchema.safeParse({ ...room, ratePlans }).success, false);
  }
});
