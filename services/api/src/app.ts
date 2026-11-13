import express from 'express';
import type { MongoClient } from 'mongodb';
import type { Pool } from 'pg';
import { z } from 'zod';
import { registerAccountEmail, type AccountMailer } from './account-email.js';
import { registerAuth } from './auth.js';
import { registerBookings, staySchema, validStay } from './bookings.js';
import { registerManagement } from './management.js';
import { registerHotelProfiles } from './hotel-profile.js';
import { registerTravelSearch } from './travel-search.js';
import { hotelSearchFilter } from './hotel-search.js';
import { errors, route } from './http.js';

export function createApp(mongo: MongoClient, pool: Pool, mailer?: AccountMailer) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => { res.json({ ok: true, service: 'geobook-api' }); });
  registerAuth(app, pool);
  registerAccountEmail(app, pool, mailer);
  registerBookings(app, pool, mongo);
  registerManagement(app, pool, mongo);
  registerHotelProfiles(app, mongo, pool);
  registerTravelSearch(app, mongo);
  app.get('/api/health/ready', route(async (_req, res) => {
    await mongo.db('geobook').command({ ping: 1 }); await pool.query('SELECT 1');
    res.json({ ok: true, hotels: await mongo.db('geobook').collection('hotels').countDocuments() });
  }));
  app.get('/api/hotels', route(async (req, res) => {
    const data = z.object({ q: z.string().trim().max(120).default(''), page: z.coerce.number().int().min(1).max(10000).default(1),
      minPrice: z.coerce.number().nonnegative().default(0), maxPrice: z.coerce.number().nonnegative().optional(),
      sort: z.enum(['name', 'price']).default('name'), demo: z.enum(['true', 'false']).optional(),
      checkIn: z.string().optional(), checkOut: z.string().optional(), guests: z.coerce.number().int().min(1).max(30).default(2),
    }).parse(req.query);
    const conditions: any[] = [{ active: { $ne: false } }];
    if (data.q) conditions.push(hotelSearchFilter(data.q));
    if (data.demo !== undefined) conditions.push({ synthetic: data.demo === 'true' });
    if (data.maxPrice !== undefined || data.minPrice > 0) conditions.push({ priceFrom: { $gte: data.minPrice, ...(data.maxPrice !== undefined ? { $lte: data.maxPrice } : {}) } });
    if (data.checkIn || data.checkOut) {
      const stay = staySchema.parse(data); validStay(stay);
      const ids = (await pool.query(`SELECT DISTINCT r.hotel_id FROM rooms r JOIN properties p ON p.hotel_id=r.hotel_id WHERE r.active AND p.published AND NOT p.suspended AND r.capacity >= $3
        AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.room_id=r.id::text AND b.status='confirmed' AND b.stay && daterange($1,$2,'[)'))
        AND NOT EXISTS(SELECT 1 FROM room_blocks k WHERE k.room_id=r.id AND k.stay && daterange($1,$2,'[)'))`, [stay.checkIn, stay.checkOut, stay.guests])).rows.map(r => r.hotel_id);
      conditions.push({ _id: { $in: ids } });
    }
    const collection = mongo.db('geobook').collection('hotels'); const filter = { $and: conditions };
    const [rows, total] = await Promise.all([
      collection.aggregate([{ $match: filter }, { $addFields: { _sortPrice: { $ifNull: ['$priceFrom', 1000000000] } } },
        { $sort: data.sort === 'price' ? { _sortPrice: 1, _id: 1 } : { name: 1, _id: 1 } },
        { $skip: (data.page - 1) * 20 }, { $limit: 20 }, { $project: { _sortPrice: 0 } }]).toArray(), collection.countDocuments(filter),
    ]);
    res.json({ data: rows, meta: { query: data.q, page: data.page, total, hasMore: data.page * 20 < total } });
  }));
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  app.use(errors);
  return app;
}
