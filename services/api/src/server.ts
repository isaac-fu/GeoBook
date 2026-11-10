import express from 'express';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { Kafka } from 'kafkajs';
import { z } from 'zod';
import { registerTravelSearch } from './travel-search.js';

const app = express(); app.use(express.json());
const mongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017/geobook');
const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://geobook:geobook@localhost:5432/geobook' });
const kafka = new Kafka({ clientId: 'geobook-api', brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',') });
const producer = kafka.producer();
registerTravelSearch(app, mongo);

app.get('/health', (_, res) => res.json({ ok: true, service: 'geobook-api' }));
app.get('/api/hotels', async (req, res) => {
  await mongo.connect();
  const q = String(req.query.q ?? ''); const min = Number(req.query.minPrice ?? 0); const max = Number(req.query.maxPrice ?? 100000);
  const hotels = await mongo.db('geobook').collection('hotels').find({ $and: [{ $or: [{ name: { $regex: q, $options: 'i' } }, { city: { $regex: q, $options: 'i' } }] }, { priceFrom: { $gte: min, $lte: max } }] }).limit(50).toArray();
  res.json({ data: hotels });
});
const bookingSchema = z.object({ userId: z.string().uuid(), hotelId: z.string(), roomId: z.string(), checkIn: z.string(), checkOut: z.string(), totalCents: z.number().int().positive() });
app.post('/api/bookings', async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const b = parsed.data; const client = await pg.connect();
  try { await client.query('BEGIN'); const result = await client.query('INSERT INTO bookings (user_id, hotel_id, room_id, stay, total_cents) VALUES ($1,$2,$3, daterange($4,$5,\'[)\'),$6) RETURNING *', [b.userId,b.hotelId,b.roomId,b.checkIn,b.checkOut,b.totalCents]); await client.query('COMMIT'); await producer.connect(); await producer.send({ topic:'geobook.events', messages:[{ key: result.rows[0].id, value: JSON.stringify({ type:'booking.created', booking: result.rows[0] }) }] }); res.status(201).json(result.rows[0]); }
  catch (error) { await client.query('ROLLBACK'); res.status(409).json({ error: 'Room is no longer available for those dates.' }); } finally { client.release(); }
});
app.listen(Number(process.env.PORT ?? 4000), () => console.log('GeoBook API listening on 4000'));
