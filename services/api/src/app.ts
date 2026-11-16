import Stripe from 'stripe';
import { payments } from './payments.js';
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
import { configuredSearch, type ElasticSearch, SEARCH_LIMIT } from './elastic-search.js';

export function createApp(mongo: MongoClient, pool: Pool, mailer?: AccountMailer, stripe?: Stripe, search: ElasticSearch | undefined = configuredSearch()) {
  const app = express(); const payment = payments(pool, stripe); payment.webhook(app); app.disable('x-powered-by'); app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => { res.json({ ok: true, service: 'geobook-api' }); });
  registerAuth(app, pool);
  registerAccountEmail(app, pool, mailer);
  registerBookings(app, pool, mongo, payment);
  payment.routes(app);
  registerManagement(app, pool, mongo);
  registerHotelProfiles(app, mongo, pool);
  registerTravelSearch(app, mongo);
  app.get('/api/health/ready', route(async (_req, res) => {
    await mongo.db('geobook').command({ ping: 1 }); await pool.query('SELECT 1');
    res.json({ ok: true, hotels: await mongo.db('geobook').collection('hotels').countDocuments() });
  }));
  app.get('/api/hotels', route(async (req, res) => {
    const data = z.object({ q: z.string().trim().max(120).default(''), page: z.coerce.number().int().min(1).max(500).default(1),
      minPrice: z.coerce.number().nonnegative().default(0), maxPrice: z.coerce.number().nonnegative().optional(),
      sort: z.enum(['relevance', 'name', 'price']).default('relevance'), demo: z.enum(['true', 'false']).optional(),
      checkIn: z.string().optional(), checkOut: z.string().optional(), guests: z.coerce.number().int().min(1).max(30).default(2),
    }).refine(d => d.maxPrice === undefined || d.maxPrice >= d.minPrice, { message: 'Maximum price must be at least minimum price' }).parse(req.query);
    const conditions: any[] = [{ active: { $ne: false } }];
    if (data.demo !== undefined) conditions.push({ synthetic: data.demo === 'true' });
    if (data.maxPrice !== undefined || data.minPrice > 0) conditions.push({ priceFrom: { $gte: data.minPrice, ...(data.maxPrice !== undefined ? { $lte: data.maxPrice } : {}) } });
    if (data.checkIn || data.checkOut) {
      const stay = staySchema.parse(data); validStay(stay);
      const ids = (await pool.query(`SELECT DISTINCT r.hotel_id FROM rooms r JOIN properties p ON p.hotel_id=r.hotel_id WHERE r.active AND p.published AND NOT p.suspended AND r.capacity >= $3
        AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.room_id=r.id::text AND b.status='confirmed' AND b.stay && daterange($1,$2,'[)'))
        AND NOT EXISTS(SELECT 1 FROM room_blocks k WHERE k.room_id=r.id AND k.stay && daterange($1,$2,'[)'))`, [stay.checkIn, stay.checkOut, stay.guests])).rows.map(r => r.hotel_id);
      conditions.push({ _id: { $in: ids } });
    }
    const collection = mongo.db('geobook').collection<any>('hotels');
    if (search) {
      try {
        // Never trust the eventually consistent index for visibility, price eligibility, or live inventory.
        const eligible = await collection.find({ $and: conditions }, { projection: { _id: 1 } }).limit(SEARCH_LIMIT + 1).toArray();
        const found = await search.search(data, eligible.map(h => String(h._id)));
        const current = await collection.find({ $and: [...conditions, { _id: { $in: found.ids } }] }).toArray();
        const byId = new Map(current.map(h => [h._id, h]));
        res.json({ data: found.ids.map(id => byId.get(id)).filter(Boolean), meta: { query: data.q, page: data.page, total: found.total, hasMore: data.page < 500 && data.page * 20 < found.total, searchEngine: 'elasticsearch', degraded: false } });
        return;
      } catch { /* A missing index or unavailable search cluster must not prevent catalog discovery. */ }
    }
    if (data.q) conditions.push(hotelSearchFilter(data.q));
    const filter = { $and: conditions };
    const [rows, total] = await Promise.all([
      collection.aggregate([{ $match: filter }, { $addFields: { _sortPrice: { $ifNull: ['$priceFrom', 1000000000] } } },
        { $sort: data.sort === 'price' ? { _sortPrice: 1, _id: 1 } : { name: 1, _id: 1 } },
        { $skip: (data.page - 1) * 20 }, { $limit: 20 }, { $project: { _sortPrice: 0 } }]).toArray(), collection.countDocuments(filter),
    ]);
    res.json({ data: rows, meta: { query: data.q, page: data.page, total, hasMore: data.page < 500 && data.page * 20 < total, searchEngine: 'mongodb', degraded: !!search } });
  }));
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  app.use(errors);
  return app;
}
