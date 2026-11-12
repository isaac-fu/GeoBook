import type { Express } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { MongoClient } from 'mongodb';
import { z } from 'zod';
import { route, user, HttpError } from './http.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const staySchema = z.object({ checkIn: dateSchema, checkOut: dateSchema, guests: z.coerce.number().int().min(1).max(30) })
  .refine(stay => stay.checkOut > stay.checkIn, { message: 'Check-out must be after check-in' });
export function nights(stay: { checkIn: string; checkOut: string }) { return (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000; }
export function validStay(stay: z.infer<typeof staySchema>) {
  if (stay.checkIn < new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'Check-in cannot be in the past.');
  if (nights(stay) > 90) throw new HttpError(400, 'A stay cannot exceed 90 nights.');
}
export const bookingSelect = `SELECT b.*,lower(b.stay)::text AS check_in,upper(b.stay)::text AS check_out,
  EXISTS(SELECT 1 FROM reviews v WHERE v.booking_id=b.id) AS reviewed FROM bookings b`;
export async function emit(client: PoolClient, type: string, booking: any) {
  const message = `${type === 'booking.created' ? 'Reservation confirmed' : 'Reservation cancelled'}: ${booking.hotel_name}.`;
  await client.query('INSERT INTO outbox(event_type,payload) VALUES($1,$2)', [type, JSON.stringify({ userId: booking.user_id, bookingId: booking.id, message })]);
}
export async function availability(pool: Pool, hotelId: string, stay: z.infer<typeof staySchema>) {
  validStay(stay);
  const property = await pool.query('SELECT * FROM properties WHERE hotel_id=$1 AND published=true AND NOT suspended', [hotelId]);
  if (!property.rowCount) return { status: 'not_connected', rooms: [], message: 'Online booking is not connected for this property. No reservation has been made.' };
  const result = await pool.query(`SELECT r.* FROM rooms r WHERE r.hotel_id=$1 AND r.active=true AND r.capacity >= $4
    AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.room_id=r.id::text AND b.status='confirmed' AND b.stay && daterange($2,$3,'[)'))
    AND NOT EXISTS(SELECT 1 FROM room_blocks k WHERE k.room_id=r.id AND k.stay && daterange($2,$3,'[)')) ORDER BY r.nightly_cents,r.id`, [hotelId, stay.checkIn, stay.checkOut, stay.guests]);
  return { status: result.rowCount ? 'available' : 'sold_out', demo: property.rows[0].demo, nights: nights(stay),
    rooms: result.rows.map(r => ({ ...r, totalCents: r.nightly_cents * nights(stay) })),
    message: result.rowCount ? 'Choose a room to review your reservation.' : 'No rooms available for these dates and guests.' };
}
const reserveSchema = z.object({ hotelId: z.string().min(1).max(200), roomId: z.uuid(), requestKey: z.uuid(),
  checkIn: dateSchema, checkOut: dateSchema, guests: z.number().int().min(1).max(30),
  expectedTotalCents: z.number().int().positive(), guestName: z.string().trim().min(2).max(100), specialRequests: z.string().trim().max(1000).default(''),
}).refine(s => s.checkOut > s.checkIn, { message: 'Check-out must be after check-in' });
function replayMatches(booking: any, data: z.infer<typeof reserveSchema>) {
  if (booking.hotel_id !== data.hotelId || booking.room_id !== data.roomId || booking.check_in !== data.checkIn || booking.check_out !== data.checkOut || booking.guest_count !== data.guests || booking.total_cents !== data.expectedTotalCents || booking.guest_name !== data.guestName || booking.special_requests !== data.specialRequests) {
    throw new HttpError(409, 'This request key was already used for a different reservation.');
  }
}
export function registerBookings(app: Express, pool: Pool, mongo: MongoClient) {
  app.post('/api/bookings', route(async (req, res) => {
    const current = user(res); const data = reserveSchema.parse(req.body); validStay(data);
    const previous = await pool.query(`${bookingSelect} WHERE b.user_id=$1 AND b.request_key=$2`, [current.id, data.requestKey]);
    if (previous.rowCount) { replayMatches(previous.rows[0], data); res.json({ data: previous.rows[0], replay: true }); return; }
    const hotel = await mongo.db('geobook').collection<any>('hotels').findOne({ _id: data.hotelId, active: { $ne: false } });
    if (!hotel) throw new HttpError(404, 'Hotel not found.');
    const client = await pool.connect();
    let booking;
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT r.*,p.demo FROM rooms r JOIN properties p ON p.hotel_id=r.hotel_id WHERE r.id=$1 AND r.hotel_id=$2 AND r.active AND p.published AND NOT p.suspended FOR UPDATE OF r,p', [data.roomId, data.hotelId]);
      const room = result.rows[0];
      if (!room || room.capacity < data.guests) throw new HttpError(409, 'This room is unavailable for the selected guests.');
      const replay = await client.query(`${bookingSelect} WHERE b.user_id=$1 AND b.request_key=$2`, [current.id, data.requestKey]);
      if (replay.rowCount) { replayMatches(replay.rows[0], data); await client.query('COMMIT'); res.json({ data: replay.rows[0], replay: true }); return; }
      const total = room.nightly_cents * nights(data);
      if (total !== data.expectedTotalCents) throw new HttpError(409, 'The room rate changed. Check availability again.');
      const blocked = await client.query("SELECT 1 FROM room_blocks WHERE room_id=$1 AND stay && daterange($2,$3,'[)')", [data.roomId, data.checkIn, data.checkOut]);
      if (blocked.rowCount) throw new HttpError(409, 'This room is no longer available.');
      const inserted = await client.query(`INSERT INTO bookings(user_id,hotel_id,room_id,stay,total_cents,request_key,hotel_name,room_name,guest_name,guest_count,special_requests,currency,demo)
        VALUES($1,$2,$3,daterange($4,$5,'[)'),$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [current.id, data.hotelId, data.roomId, data.checkIn, data.checkOut, total, data.requestKey, hotel.name, room.name, data.guestName, data.guests, data.specialRequests, room.currency, room.demo]);
      await emit(client, 'booking.created', inserted.rows[0]);
      booking = (await client.query(`${bookingSelect} WHERE b.id=$1`, [inserted.rows[0].id])).rows[0];
      await client.query('COMMIT');
    } catch (e: any) {
      await client.query('ROLLBACK');
      if (e.code === '23505' || e.code === '23P01') {
        const replay = await pool.query(`${bookingSelect} WHERE b.user_id=$1 AND b.request_key=$2`, [current.id, data.requestKey]);
        if (replay.rowCount) { replayMatches(replay.rows[0], data); res.json({ data: replay.rows[0], replay: true }); return; }
      }
      throw e;
    } finally { client.release(); }
    res.status(201).json({ data: booking });
  }));
  app.get('/api/bookings', route(async (req, res) => {
    const current = user(res);
    res.json({ data: (await pool.query(`${bookingSelect} WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 200`, [current.id])).rows });
  }));
  app.post('/api/bookings/:id/cancel', route(async (req, res) => {
    const current = user(res); const id = z.uuid().parse(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`${bookingSelect} WHERE b.id=$1 AND b.user_id=$2 FOR UPDATE OF b`, [id, current.id]);
      const booking = result.rows[0]; if (!booking) throw new HttpError(404, 'Reservation not found.');
      if (booking.status === 'cancelled') { await client.query('COMMIT'); res.json({ data: booking }); return; }
      if (booking.check_in <= new Date().toISOString().slice(0, 10)) throw new HttpError(409, 'Online cancellation is available only before check-in.');
      await client.query("UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1", [id]);
      await emit(client, 'booking.cancelled', booking); await client.query('COMMIT');
      res.json({ data: { ...booking, status: 'cancelled' } });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
  app.post('/api/bookings/:id/review', route(async (req, res) => {
    const current = user(res); const id = z.uuid().parse(req.params.id);
    const data = z.object({ score: z.number().int().min(1).max(10), body: z.string().trim().min(10).max(2000) }).parse(req.body);
    const booking = await pool.query("SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND status='confirmed' AND upper(stay)<=CURRENT_DATE", [id, current.id]);
    if (!booking.rowCount) throw new HttpError(403, 'Reviews are available only after your completed stay.');
    const result = await pool.query('INSERT INTO reviews(booking_id,user_id,hotel_id,score,body) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, current.id, booking.rows[0].hotel_id, data.score, data.body]);
    res.status(201).json({ data: result.rows[0] });
  }));
  app.get('/api/favorites', route(async (_req, res) => {
    const current = user(res); const saved = await pool.query('SELECT hotel_id FROM favorites WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200', [current.id]);
    const hotels = await mongo.db('geobook').collection<any>('hotels').find({ _id: { $in: saved.rows.map(r => r.hotel_id) }, active: { $ne: false } }).toArray();
    res.json({ data: saved.rows.map(r => hotels.find(h => h._id === r.hotel_id)).filter(Boolean) });
  }));
  app.post('/api/favorites/:id', route(async (req, res) => {
    const current = user(res); const id = z.string().min(1).max(200).parse(req.params.id);
    if (!await mongo.db('geobook').collection<any>('hotels').findOne({ _id: id, active: { $ne: false } })) throw new HttpError(404, 'Hotel not found.');
    await pool.query('INSERT INTO favorites(user_id,hotel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [current.id, id]); res.json({ ok: true });
  }));
  app.delete('/api/favorites/:id', route(async (req, res) => {
    const current = user(res); await pool.query('DELETE FROM favorites WHERE user_id=$1 AND hotel_id=$2', [current.id, req.params.id]); res.json({ ok: true });
  }));
  app.get('/api/notifications', route(async (_req, res) => {
    const current = user(res); res.json({ data: (await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [current.id])).rows });
  }));
  app.post('/api/notifications/read', route(async (_req, res) => {
    const current = user(res); await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [current.id]); res.json({ ok: true });
  }));
}
