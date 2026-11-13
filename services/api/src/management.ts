import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import type { Pool } from 'pg';
import type { MongoClient } from 'mongodb';
import { z } from 'zod';
import { route, user, HttpError } from './http.js';
import { roomSchema } from './room-rates.js';
import { staySchema, validStay, bookingSelect } from './bookings.js';

const detailsSchema = z.object({
  name: z.string().trim().min(3).max(200), description: z.string().trim().min(20).max(10000),
  city: z.string().trim().min(1).max(100), province: z.string().trim().min(1).max(100),
  country: z.string().trim().min(1).max(100), countryCode: z.string().regex(/^[A-Z]{2}$/),
  address: z.string().trim().max(300),
  location: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
  amenities: z.array(z.string().trim().min(1).max(80)).max(30),
  images: z.array(z.object({ url: z.url().startsWith('https://'), attribution: z.string().min(1).max(200), license: z.string().min(1).max(100) })).max(10).default([]),
  published: z.boolean().default(true),
});
export function registerManagement(app: Express, pool: Pool, mongo: MongoClient) {
  const hotels = mongo.db('geobook').collection<any>('hotels');
  async function owned(id: string, res: Response) {
    const current = user(res, ['hotel', 'admin']);
    const result = await pool.query('SELECT * FROM properties WHERE hotel_id=$1 AND owner_id=$2', [id, current.id]);
    if (!result.rowCount) throw new HttpError(404, 'Property not found.'); return result.rows[0];
  }
  async function refreshPrice(id: string) {
    const result = await pool.query('SELECT min(nightly_cents)::int AS price FROM rooms WHERE hotel_id=$1 AND active', [id]);
    await hotels.updateOne({ _id: id }, { $set: { priceFrom: result.rows[0].price == null ? null : result.rows[0].price / 100, currency: 'USD' } });
  }
  app.get('/api/operator/properties', route(async (_req, res) => {
    const current = user(res, ['hotel', 'admin']);
    const properties = (await pool.query('SELECT * FROM properties WHERE owner_id=$1 ORDER BY created_at', [current.id])).rows;
    const documents = await hotels.find({ _id: { $in: properties.map(p => p.hotel_id) } }).toArray();
    const rooms = (await pool.query('SELECT r.* FROM rooms r JOIN properties p ON p.hotel_id=r.hotel_id WHERE p.owner_id=$1 ORDER BY r.created_at', [current.id])).rows;
    const blocks = (await pool.query('SELECT k.*,lower(k.stay)::text AS check_in,upper(k.stay)::text AS check_out FROM room_blocks k JOIN rooms r ON r.id=k.room_id JOIN properties p ON p.hotel_id=r.hotel_id WHERE p.owner_id=$1 ORDER BY lower(k.stay)', [current.id])).rows;
    res.json({ data: properties.map(p => ({ ...documents.find(h => h._id === p.hotel_id), ...p, rooms: rooms.filter(r => r.hotel_id === p.hotel_id).map(r => ({ ...r, blocks: blocks.filter(k => k.room_id === r.id) })) })) });
  }));
  app.post('/api/operator/properties', route(async (req, res) => {
    const current = user(res, ['hotel', 'admin']); const data = detailsSchema.parse(req.body);
    const id = `demo:${randomUUID()}`; const { published, ...details } = data;
    // New local inventory is explicitly demo inventory until a real supplier is integrated.
    await hotels.insertOne({ _id: id, ...details, active: false, synthetic: true, priceFrom: null, currency: 'USD', rating: null,
      source: { provider: 'GeoBook demo', id, url: 'https://example.com/geobook-demo', license: 'Demo content', attribution: 'Property supplied by demo operator', fetchedAt: new Date().toISOString() } });
    await pool.query('INSERT INTO properties(hotel_id,owner_id,published,demo) VALUES($1,$2,$3,true)', [id, current.id, published]);
    await hotels.updateOne({ _id: id }, { $set: { active: published } });
    res.status(201).json({ id });
  }));
  app.put('/api/operator/properties/:id', route(async (req, res) => {
    const property = await owned(req.params.id, res); const { published, ...details } = detailsSchema.parse(req.body);
    await pool.query('UPDATE properties SET published=$1 WHERE hotel_id=$2', [published, property.hotel_id]);
    await hotels.updateOne({ _id: property.hotel_id }, { $set: { ...details, active: published && !property.suspended } });
    res.json({ ok: true });
  }));
  app.post('/api/operator/properties/:id/rooms', route(async (req, res) => {
    await owned(req.params.id, res); const data = roomSchema.parse(req.body);
    const result = await pool.query('INSERT INTO rooms(hotel_id,name,capacity,nightly_cents,active,room_type,rate_plans) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.params.id, data.name, data.capacity, data.nightlyCents, data.active, data.roomType, JSON.stringify(data.ratePlans)]);
    await refreshPrice(req.params.id); res.status(201).json({ data: result.rows[0] });
  }));
  app.put('/api/operator/rooms/:id', route(async (req, res) => {
    const current = user(res, ['hotel', 'admin']); const id = z.uuid().parse(req.params.id); const data = roomSchema.parse(req.body);
    const result = await pool.query('UPDATE rooms r SET name=$1,capacity=$2,nightly_cents=$3,active=$4,room_type=$7,rate_plans=$8 FROM properties p WHERE r.hotel_id=p.hotel_id AND p.owner_id=$5 AND r.id=$6 RETURNING r.*', [data.name, data.capacity, data.nightlyCents, data.active, current.id, id, data.roomType, JSON.stringify(data.ratePlans)]);
    if (!result.rowCount) throw new HttpError(404, 'Room not found.'); await refreshPrice(result.rows[0].hotel_id); res.json({ ok: true });
  }));
  app.post('/api/operator/rooms/:id/blocks', route(async (req, res) => {
    const current = user(res, ['hotel', 'admin']); const id = z.uuid().parse(req.params.id); const stay = staySchema.parse({ ...req.body, guests: 1 }); validStay(stay);
    const reason = z.string().trim().max(200).default('Unavailable').parse(req.body.reason);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const room = await client.query('SELECT r.id FROM rooms r JOIN properties p ON p.hotel_id=r.hotel_id WHERE r.id=$1 AND p.owner_id=$2 FOR UPDATE OF r', [id, current.id]);
      if (!room.rowCount) throw new HttpError(404, 'Room not found.');
      const existing = await client.query("SELECT 1 FROM bookings WHERE room_id=$1 AND status='confirmed' AND stay && daterange($2,$3,'[)')", [id, stay.checkIn, stay.checkOut]);
      if (existing.rowCount) throw new HttpError(409, 'A confirmed reservation overlaps these dates.');
      await client.query("INSERT INTO room_blocks(room_id,stay,reason) VALUES($1,daterange($2,$3,'[)'),$4)", [id, stay.checkIn, stay.checkOut, reason]);
      await client.query('COMMIT'); res.status(201).json({ ok: true });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
  app.delete('/api/operator/blocks/:id', route(async (req, res) => {
    const current = user(res, ['hotel', 'admin']); const id = z.uuid().parse(req.params.id);
    const result = await pool.query('DELETE FROM room_blocks k USING rooms r,properties p WHERE k.room_id=r.id AND r.hotel_id=p.hotel_id AND p.owner_id=$1 AND k.id=$2', [current.id, id]);
    if (!result.rowCount) throw new HttpError(404, 'Block not found.'); res.json({ ok: true });
  }));
  app.get('/api/operator/bookings', route(async (_req, res) => {
    const current = user(res, ['hotel', 'admin']); res.json({ data: (await pool.query(`${bookingSelect} JOIN properties p ON p.hotel_id=b.hotel_id WHERE p.owner_id=$1 ORDER BY b.created_at DESC LIMIT 200`, [current.id])).rows });
  }));
  app.get('/api/admin/overview', route(async (_req, res) => {
    user(res, ['admin']);
    const stats = (await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM bookings WHERE status='confirmed') AS confirmed,
      (SELECT count(*)::int FROM bookings WHERE status='cancelled') AS cancelled,
      (SELECT coalesce(sum(total_cents),0)::bigint FROM bookings WHERE status='confirmed') AS gross_cents,
      (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS pending_events`)).rows[0];
    res.json({ data: { ...stats, hotels: await hotels.countDocuments(), currency: 'USD', demo: true } });
  }));
  app.get('/api/admin/users', route(async (_req, res) => {
    user(res, ['admin']); res.json({ data: (await pool.query('SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC LIMIT 200')).rows });
  }));
  app.get('/api/admin/hotels', route(async (_req, res) => {
    user(res, ['admin']); res.json({ data: await hotels.find({}, { projection: { name: 1, city: 1, active: 1, synthetic: 1 } }).sort({ name: 1 }).limit(500).toArray() });
  }));
  app.patch('/api/admin/hotels/:id', route(async (req, res) => {
    user(res, ['admin']); const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const property = await pool.query('UPDATE properties SET suspended=$1 WHERE hotel_id=$2 RETURNING published', [!active, req.params.id]);
    const result = await hotels.updateOne({ _id: req.params.id }, { $set: { active: active && (property.rows[0]?.published ?? true) } });
    if (!result.matchedCount) throw new HttpError(404, 'Hotel not found.'); res.json({ ok: true });
  }));
}
