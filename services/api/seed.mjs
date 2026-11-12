import { MongoClient } from 'mongodb';
// Synthetic properties near Midtown. Reruns preserve existing records.
const client = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017/geobook');
try {
  await client.connect();
  const hotels = client.db('geobook').collection('hotels');
  await hotels.createIndex({ location: '2dsphere' });
  const names = ['Garden', 'Terrace', 'Park', 'Corner', 'Avenue', 'Courtyard'];
  await hotels.bulkWrite(Array.from({ length: 60 }, (_, i) => ({ updateOne: {
    filter: { _id: `geobook-demo-${i}` },
    update: { $setOnInsert: {
      name: `Demo ${names[i % names.length]} Hotel ${i + 1}`, city: 'New York',
      priceFrom: 90 + (i * 17) % 220, currency: 'USD', synthetic: true,
      location: { type: 'Point', coordinates: [-74.002 + (i % 6) * 0.006, 40.728 + Math.floor(i / 6) * 0.005] },
    } }, upsert: true,
  } })));
  console.log('60 synthetic demo hotel records ready in geobook.hotels.');
  await hotels.updateMany({ _id: { $in: Array.from({ length: 60 }, (_, i) => `geobook-demo-${i}`) }, synthetic: true },
    { $set: { country: 'United States', countryCode: 'US', province: 'New York', state: 'New York' } });
} finally { await client.close(); }
