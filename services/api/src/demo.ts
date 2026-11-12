import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { MongoClient } from 'mongodb';
import { hashPassword } from './auth.js';

export async function seedDemo(pool: Pool, mongo: MongoClient) {
  // No published/default password: the seed owner cannot log in unless explicitly configured.
  const owner = await pool.query(`INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,'Demo Property Team','hotel')
    ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, ['demo.owner@geobook.test', await hashPassword(process.env.DEMO_PASSWORD || randomBytes(32).toString('hex'))]);
  const properties = [
    { _id: 'demo:sf-harbor-house', name: 'Demo Harbor House', city: 'San Francisco', province: 'California', address: 'Fictional property near Union Square', coordinates: [-122.407, 37.787], price: 12900 },
    { _id: 'demo:ny-park-house', name: 'Demo Park House', city: 'New York', province: 'New York', address: 'Fictional property near Midtown', coordinates: [-73.985, 40.751], price: 15900 },
  ];
  for (const [index, p] of properties.entries()) {
    await mongo.db('geobook').collection<any>('hotels').updateOne({ _id: p._id }, { $setOnInsert: {
      _id: p._id, name: p.name, city: p.city, province: p.province, country: 'United States', countryCode: 'US', address: p.address,
      description: 'A fictional GeoBook property for trying the complete reservation experience. Choose a private room, review the nightly rate, and create a demo reservation. No real accommodation is reserved and no payment is taken.',
      location: { type: 'Point', coordinates: p.coordinates }, priceFrom: p.price / 100, currency: 'USD', amenities: ['Wi-Fi (demo)', 'Private bathroom (demo)', '24-hour reception (demo)'],
      images: [], rating: null, synthetic: true, active: true, source: { provider: 'GeoBook demo', id: p._id, url: 'https://example.com/geobook-demo', license: 'Demo content', attribution: 'Fictional GeoBook demonstration property', fetchedAt: new Date().toISOString() },
    } }, { upsert: true });
    await pool.query('INSERT INTO properties(hotel_id,owner_id,demo) VALUES($1,$2,true) ON CONFLICT DO NOTHING', [p._id, owner.rows[0].id]);
    for (let room = 1; room <= 3; room++) {
      const id = `00000000-0000-4000-8000-${String(index * 10 + room).padStart(12, '0')}`;
      await pool.query('INSERT INTO rooms(id,hotel_id,name,capacity,nightly_cents) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id, p._id, room === 3 ? 'Family room 103' : `Double room ${100 + room}`, room === 3 ? 4 : 2, p.price + (room === 3 ? 5000 : 0)]);
    }
  }
}
