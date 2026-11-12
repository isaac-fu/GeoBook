import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Express, Response, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { HttpError, route, user } from './http.js';
const derive = promisify(scrypt);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [kind, salt, value] = hash.split(':');
  if (kind !== 'scrypt' || !salt || !value || value.length !== 128) return false;
  return timingSafeEqual(await derive(password, salt, 64) as Buffer, Buffer.from(value, 'hex'));
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const passwordSchema = z.string().min(12).max(128);
const credentials = z.object({ email: z.email().max(254).transform(v => v.toLowerCase().trim()), password: passwordSchema });
const register = credentials.extend({ name: z.string().trim().min(2).max(100), role: z.enum(['guest', 'hotel']).default('guest') });
function token(req: { headers: { cookie?: string } }) { return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('geobook_session='))?.slice(16); }
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.SECURE_COOKIES === 'true', path: '/' });
export function registerAuth(app: Express, pool: Pool) {
  // Browsers cannot forge this header cross-origin without a successful CORS preflight.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-GeoBook-Request') !== '1') { res.status(403).json({ error: 'Missing request protection header.' }); return; }
    const origin = req.get('Origin');
    if (origin) { try { if (new URL(origin).host !== req.get('host')) throw new Error(); } catch { res.status(403).json({ error: 'Cross-origin request rejected.' }); return; } }
    next();
  });
  const sessionMiddleware: RequestHandler = (req, res, next) => {
    const value = token(req);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) { next(); return; }
    pool.query('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [digest(value)])
      .then(result => { res.locals.user = result.rows[0]; next(); }).catch(next);
  };
  app.use('/api', sessionMiddleware);
  const attempts = new Map<string, { count: number; until: number }>();
  const limit: RequestHandler = (req, res, next) => {
    const now = Date.now(); for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const key = req.ip ?? 'unknown'; const value = attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
    value.count++; attempts.set(key, value);
    if (value.count > 50 || attempts.size > 10000) { res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' }); return; } next();
  };
  async function issue(res: Response, id: string) {
    const value = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM sessions WHERE expires_at<now()');
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", [digest(value), id]);
    res.cookie('geobook_session', value, { ...cookieOptions(), maxAge: 7 * 86400000 });
  }
  app.post('/api/auth/register', limit, route(async (req, res) => {
    const data = register.parse(req.body);
    const result = await pool.query('INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role', [data.email, await hashPassword(data.password), data.name, data.role]);
    await issue(res, result.rows[0].id); res.status(201).json({ user: result.rows[0] });
  }));
  app.post('/api/auth/login', limit, route(async (req, res) => {
    const data = credentials.parse(req.body);
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [data.email]);
    const candidate = result.rows[0];
    // Derive even for an unknown account to reduce account-enumeration timing differences.
    const valid = await verifyPassword(data.password, candidate?.password_hash ?? `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`);
    if (!candidate || !valid) throw new HttpError(401, 'Email or password is incorrect.');
    const { id, name, email, role } = candidate;
    await issue(res, id); res.json({ user: { id, name, email, role } });
  }));
  app.get('/api/auth/me', (req, res) => { res.json({ user: res.locals.user ?? null }); });
  app.post('/api/auth/logout', route(async (req, res) => {
    const value = token(req); if (value) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [digest(value)]);
    res.clearCookie('geobook_session', cookieOptions()); res.json({ ok: true });
  }));
  app.patch('/api/account', route(async (req, res) => {
    const current = user(res); const data = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body);
    const result = await pool.query('UPDATE users SET name=$1 WHERE id=$2 RETURNING id,name,email,role', [data.name, current.id]);
    res.json({ user: result.rows[0] });
  }));
  app.post('/api/account/password', route(async (req, res) => {
    const current = user(res); const data = z.object({ currentPassword: passwordSchema, newPassword: passwordSchema }).parse(req.body);
    const existing = await pool.query('SELECT password_hash FROM users WHERE id=$1', [current.id]);
    if (!await verifyPassword(data.currentPassword, existing.rows[0].password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(data.newPassword), current.id]); await client.query('DELETE FROM sessions WHERE user_id=$1', [current.id]); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await issue(res, current.id); res.json({ ok: true });
  }));
}
