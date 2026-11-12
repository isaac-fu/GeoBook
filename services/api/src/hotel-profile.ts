import type { Express } from 'express';
import type { MongoClient } from 'mongodb';
import type { Pool } from 'pg';
import { route, HttpError } from './http.js';
import { staySchema, availability } from './bookings.js';
export { staySchema } from './bookings.js';

export function registerHotelProfiles(app: Express, mongo: MongoClient, pool: Pool) {
  const collection = mongo.db('geobook').collection<any>('hotels');
  app.get('/api/hotels/:id', route(async (req, res) => {
    const hotel = await collection.findOne({ _id: req.params.id, active: { $ne: false } });
    if (!hotel) throw new HttpError(404, 'Hotel not found.');
    const rating = (await pool.query('SELECT round(avg(score),1)::float AS score,count(*)::int AS count FROM reviews WHERE hotel_id=$1', [req.params.id])).rows[0];
    const property = (await pool.query('SELECT demo FROM properties WHERE hotel_id=$1 AND published AND NOT suspended', [req.params.id])).rows[0];
    res.json({ data: { ...hotel, bookingConnected: !!property, demo: property?.demo ?? hotel.synthetic,
      rating: rating.count ? { score: rating.score, scale: 10, reviewCount: rating.count, provider: 'GeoBook verified stays' } : hotel.rating ?? null } });
  }));
  app.get('/api/hotels/:id/availability', route(async (req, res) => {
    const stay = staySchema.parse(req.query);
    if (!await collection.findOne({ _id: req.params.id, active: { $ne: false } })) throw new HttpError(404, 'Hotel not found.');
    res.json({ ...await availability(pool, req.params.id, stay), stay });
  }));
  app.get('/api/hotels/:id/reviews', route(async (req, res) => {
    const rows = await pool.query('SELECT v.id,v.score,v.body,v.created_at,u.name FROM reviews v JOIN users u ON u.id=v.user_id WHERE hotel_id=$1 ORDER BY v.created_at DESC LIMIT 50', [req.params.id]);
    res.json({ data: rows.rows });
  }));
}
