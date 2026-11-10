import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapboxRouting, rankHotels, spatialFilter } from '../src/travel.ts';
import type { Hotel, TravelQuery } from '../src/travel.ts';

const query: TravelQuery = { anchor: [0, 0], modes: ['walking', 'cycling'], direction: 'to-anchor', ringsMinutes: [15, 30], maxMinutes: 30, match: 'any', sortBy: 'duration' };
const hotels: Hotel[] = ['a', 'b', 'c'].map(_id => ({ _id, location: { type: 'Point', coordinates: [1, 2] } }));
const matrices = {
  walking: [{ durationSeconds: 600, distanceMeters: 900 }, null, { durationSeconds: 2000, distanceMeters: 1000 }],
  cycling: [{ durationSeconds: 300, distanceMeters: 1000 }, { durationSeconds: 500, distanceMeters: 800 }, null],
};
test('ranks fastest reachable mode; excludes null and over-budget routes', () => {
  const result = rankHotels(hotels, matrices, query);
  assert.deepEqual(result.map(r => r.hotel._id), ['a', 'b']);
  assert.equal(result[0].bestMode, 'cycling');
  assert.equal(result[1].travel.walking, null);
});
test('all modes and distance budgets are enforced independently', () => {
  assert.deepEqual(rankHotels(hotels, matrices, { ...query, match: 'all' }).map(r => r.hotel._id), ['a']);
  assert.deepEqual(rankHotels(hotels, matrices, { ...query, maxDistanceMeters: 850 }).map(r => r.hotel._id), ['b']);
  assert.deepEqual(rankHotels(hotels, matrices, { ...query, sortBy: 'distance' }).map(r => r.hotel._id), ['b', 'a']);
});
test('never uses outbound polygons as inbound exclusion filters', () => {
  assert.deepEqual(spatialFilter({}, query), {});
  assert.throws(() => spatialFilter({ walking: { type: 'FeatureCollection', features: [] } }, { ...query, modes: ['walking'], direction: 'from-anchor' }), /Missing outer/);
});
test('matrix batches 24 hotels and uses correct direction and annotations', async () => {
  for (const direction of ['from-anchor', 'to-anchor'] as const) {
    const calls: URL[] = [];
    const request = (async (input: URL) => {
      calls.push(input);
      const n = input.pathname.split('/').at(-1)!.split(';').length - 1;
      assert.equal(input.searchParams.get('annotations'), 'duration,distance');
      assert.equal(input.searchParams.get(direction === 'from-anchor' ? 'sources' : 'destinations'), '0');
      const values = Array.from({ length: n }, (_, i) => i === 0 ? null : 42);
      const matrix = direction === 'from-anchor' ? [values] : values.map(n => [n]);
      return new Response(JSON.stringify({ code: 'Ok', durations: matrix, distances: matrix }));
    }) as typeof fetch;
    const result = await new MapboxRouting('test', request).matrix([0, 0], Array.from({ length: 25 }, () => hotels[0]), 'walking', direction);
    assert.equal(calls.length, 2);
    assert.equal(result.length, 25);
    assert.equal(result[0], null);
    assert.deepEqual(result[1], { durationSeconds: 42, distanceMeters: 42 });
  }
});
test('provider errors do not leak tokens or fabricate estimates', async () => {
  const routing = new MapboxRouting('secret-token', (async () => new Response('', { status: 429 })) as typeof fetch);
  await assert.rejects(routing.matrix([0, 0], hotels, 'walking', 'to-anchor'), /Routing provider unavailable/);
  await assert.rejects(new MapboxRouting('').contours([0, 0], 'walking', [15]), /not configured/);
});
