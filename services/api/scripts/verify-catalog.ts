import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { hotelSearchFilter } from '../src/hotel-search.ts';
import { hotelSchema } from '../src/hotel-model.ts';
const client = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017/geobook', { serverSelectionTimeoutMS: 5000 });
try {
  await client.connect();
  const collection = client.db('geobook').collection<any>('hotels');
  const rows = await collection.find({ 'source.provider': 'OpenStreetMap' }).toArray();
  assert.ok(rows.length > 0, 'Import the OSM sample first');
  for (const row of rows) hotelSchema.parse(row);
  const regions = new Map<string, number>();
  for (const row of rows) {
    const query = `${row.city} ${row.province} ${row.country}`;
    regions.set(query, (regions.get(query) ?? 0) + 1);
  }
  for (const [query, expected] of regions) {
    assert.ok(await collection.countDocuments(hotelSearchFilter(query)) >= expected, `Search failed: ${query}`);
  }
  const nearby = await collection.find({ location: { $near: { $geometry: rows[0].location, $maxDistance: 100 } } }).limit(10).toArray();
  assert.ok(nearby.length > 0, 'Spatial search failed');
  console.log(JSON.stringify({ verified: rows.length, geographicSearch: 'passed', spatialIndex: 'passed' }));
} finally { await client.close(); }
