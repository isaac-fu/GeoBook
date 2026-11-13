import { randomBytes, createHash } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { hashPassword } from './auth.js';
import { route, user, HttpError } from './http.js';

type Purpose = 'verify-email' | 'reset-password';
export type AccountMailer = (message: { to: string; subject: string; text: string }) => Promise<void>;
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export function accountLink(base: string, purpose: Purpose, token: string) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid PUBLIC_APP_URL');
  url.search = ''; url.hash = `/${purpose}/${token}`;
  return url.toString();
}
export function smtpMailer(): AccountMailer {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || '127.0.0.1', port: Number(process.env.SMTP_PORT || 1025),
    secure: process.env.SMTP_SECURE === 'true', requireTLS: process.env.SMTP_REQUIRE_TLS === 'true',
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } } : {}),
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async message => {
    await transport.sendMail({ from: process.env.MAIL_FROM || 'GeoBook <no-reply@geobook.test>', ...message });
  };
}

export function registerAccountEmail(app: Express, pool: Pool, mailer: AccountMailer = smtpMailer()) {
  const base = process.env.PUBLIC_APP_URL || 'http://localhost:8080/';
  accountLink(base, 'verify-email', 'configuration-check');
  const attempts = new Map<string, { count: number; until: number }>();
  const limit: RequestHandler = (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.ip || 'unknown', value = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
    value.count++; attempts.set(key, value);
    if (value.count > 30 || attempts.size > 10000) { res.status(429).json({ error: 'Too many account email requests. Try again later.' }); return; }
    next();
  };
  async function send(email: string, purpose: Purpose) {
    const client = await pool.connect();
    const token = randomBytes(32).toString('hex');
    let recipient: string | undefined;
    try {
      await client.query('BEGIN');
      // Issuance, consumption and password changes all lock the user first.
      const result = await client.query('SELECT id,email,email_verified_at FROM users WHERE email=$1 FOR UPDATE', [email]);
      const account = result.rows[0];
      if (account && !(purpose === 'verify-email' && account.email_verified_at)) {
        const recent = await client.query("SELECT 1 FROM account_tokens WHERE user_id=$1 AND purpose=$2 AND created_at>now()-interval '1 minute'", [account.id, purpose]);
        if (!recent.rowCount) {
          await client.query('DELETE FROM account_tokens WHERE user_id=$1 AND purpose=$2', [account.id, purpose]);
          await client.query("INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+($4 * interval '1 minute'))", [tokenDigest(token), account.id, purpose, purpose === 'reset-password' ? 30 : 1440]);
          recipient = account.email;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (!recipient) return;
    try {
      await mailer({ to: recipient, subject: purpose === 'reset-password' ? 'Reset your GeoBook password' : 'Verify your GeoBook email',
        text: `${purpose === 'reset-password' ? 'Reset your password' : 'Verify your email address'} using this single-use link:\n\n${accountLink(base, purpose, token)}\n\nThis link expires in ${purpose === 'reset-password' ? '30 minutes' : '24 hours'}. If you did not request this, ignore this email.`,
      });
    } catch {
      await pool.query('DELETE FROM account_tokens WHERE token_hash=$1', [tokenDigest(token)]);
      // Never log tokens, recipients, credentials or provider error bodies.
      console.error('Account email delivery failed; request a new link.');
      throw new HttpError(503, 'Email delivery is unavailable. Please try again later.');
    }
  }
  app.post('/api/account/verification-email', limit, route(async (_req, res) => {
    const current = user(res); await send(current.email, 'verify-email');
    res.json({ message: 'If your email needs verification, a link has been sent. Please wait a minute before requesting another.' });
  }));
  app.post('/api/auth/forgot-password', limit, route(async (req, res) => {
    const { email } = z.object({ email: z.email().max(254).transform(v => v.toLowerCase().trim()) }).parse(req.body);
    // Respond before account lookup/SMTP so delivery latency and failures do not reveal accounts.
    res.status(202).json({ message: 'If an account exists for that email, a reset link will be sent. Please wait a minute before requesting another.' });
    try { await send(email, 'reset-password'); } catch { console.error('Password recovery request could not be delivered.'); }
  }));
  const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
  for (const purpose of ['verify-email', 'reset-password'] as const) {
    app.post(`/api/auth/${purpose}`, limit, route(async (req, res) => {
      const token = tokenSchema.parse(req.body.token);
      const password = purpose === 'reset-password' ? z.string().min(12).max(128).parse(req.body.newPassword) : undefined;
      const passwordHash = password ? await hashPassword(password) : undefined;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const account = await client.query('SELECT id FROM users WHERE id=(SELECT user_id FROM account_tokens WHERE token_hash=$1 AND purpose=$2) FOR UPDATE', [tokenDigest(token), purpose]);
        if (!account.rowCount) throw new HttpError(400, 'This link is invalid or expired. Request a new link.');
        const consumed = await client.query('DELETE FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING user_id', [tokenDigest(token), purpose]);
        if (!consumed.rowCount) throw new HttpError(400, 'This link is invalid or expired. Request a new link.');
        const id = consumed.rows[0].user_id;
        if (passwordHash) {
          await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, id]);
          await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        } else await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1', [id]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      res.json({ ok: true });
    }));
  }
}
