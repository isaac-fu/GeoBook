import express, { type Express } from 'express';
import type { Pool, PoolClient } from 'pg';
import Stripe from 'stripe';
import { z } from 'zod';
import { HttpError, route, user } from './http.js';

export function sandboxStripe(key = process.env.STRIPE_SECRET_KEY): Stripe | undefined {
  if (!key) return undefined;
  if (!key.startsWith('sk_test_')) throw new Error('Only Stripe sandbox/test secret keys are supported.');
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required for sandbox checkout.');
  return new Stripe(key, { timeout: 10000, maxNetworkRetries: 1 });
}
export function validateSession(session: Stripe.Checkout.Session, booking: any) {
  if (session.livemode !== false || session.mode !== 'payment' || session.client_reference_id !== booking.id ||
      session.amount_total !== booking.total_cents || session.currency !== booking.currency.toLowerCase()) {
    throw new HttpError(409, 'Sandbox payment does not match this reservation.');
  }
}
export function refundBalance(refunds: Stripe.Refund[], intent: string, booking: any) {
  let refunded = 0;
  for (const refund of refunds) {
    const paymentIntent = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
    if (paymentIntent !== intent || refund.currency !== booking.currency.toLowerCase() ||
        !Number.isSafeInteger(refund.amount) || refund.amount <= 0) throw new HttpError(409, 'Refund details do not match this reservation.');
    if (refund.status === 'succeeded') refunded += refund.amount;
    else if (refund.status !== 'failed' && refund.status !== 'canceled') throw new HttpError(503, 'Sandbox refund is still pending. Retry cancellation later.');
    else if (refund.metadata?.bookingId === booking.id) throw new HttpError(503, 'Sandbox refund failed or was cancelled; operator reconciliation is required.');
  }
  if (refunded > booking.total_cents) throw new HttpError(409, 'Refund total exceeds the reservation total.');
  return booking.total_cents - refunded;
}
export function checkoutUrl(value: string | null) {
  if (!value) throw new HttpError(503, 'Checkout URL is unavailable.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password) {
    throw new HttpError(503, 'Unexpected checkout destination.');
  }
  return url.toString();
}
export function payments(pool: Pool, stripe: Stripe | undefined = sandboxStripe()) {
  const base = new URL(process.env.PUBLIC_APP_URL || 'http://localhost:8080/');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid PUBLIC_APP_URL');
  base.hash = '/bookings'; base.search = '';
  function provider() { if (!stripe) throw new HttpError(503, 'Sandbox checkout is not configured.'); return stripe; }
  async function session(client: PoolClient, booking: any, payment: any) {
    const api = provider();
    if (payment.session_id) return api.checkout.sessions.retrieve(payment.session_id);
    // Never reuse a creation key beyond Stripe's guaranteed idempotency retention window.
    if (Date.now() - new Date(payment.created_at).getTime() > 23 * 3600000) throw new HttpError(503, 'This checkout needs operator reconciliation before it can continue.');
    const result = await api.checkout.sessions.create({ mode: 'payment', allowed_payment_method_types: ['card'],
      adaptive_pricing: { enabled: false },
      client_reference_id: booking.id, success_url: base.toString(), cancel_url: base.toString(),
      line_items: [{ quantity: 1, price_data: { currency: booking.currency.toLowerCase(), unit_amount: booking.total_cents,
        product_data: { name: 'GeoBook demo reservation — sandbox payment' } } }],
    }, { idempotencyKey: `geobook-checkout-${booking.id}` });
    validateSession(result, booking);
    await client.query('UPDATE sandbox_payments SET session_id=$1 WHERE booking_id=$2', [result.id, booking.id]);
    return result;
  }
  async function sync(client: PoolClient, booking: any, current: Stripe.Checkout.Session, cancel: boolean) {
    validateSession(current, booking);
    const recorded = await client.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [booking.id]);
    if (recorded.rows[0]?.status === 'refunded') return 'refunded';
    if (cancel && current.status === 'open') {
      try { current = await provider().checkout.sessions.expire(current.id); }
      catch { current = await provider().checkout.sessions.retrieve(current.id); }
      validateSession(current, booking);
      if (current.status === 'open') throw new HttpError(503, 'Could not close sandbox checkout. Please retry cancellation.');
    }
    let status = current.payment_status === 'paid' ? 'paid' : current.status === 'expired' ? 'expired' : 'pending';
    if (cancel && status === 'paid') {
      const intent = typeof current.payment_intent === 'string' ? current.payment_intent : current.payment_intent?.id;
      if (!intent) throw new HttpError(503, 'Sandbox refund is awaiting payment details.');
      const existing: Stripe.Refund[] = [];
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page === 10) throw new HttpError(503, 'Refund history requires operator reconciliation.');
        const batch = await provider().refunds.list({ payment_intent: intent, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
        existing.push(...batch.data);
        if (!batch.has_more) break;
        const next = batch.data.at(-1)?.id;
        if (!next || next === cursor) throw new HttpError(503, 'Refund history is incomplete.');
        cursor = next;
      }
      const remaining = refundBalance(existing, intent, booking);
      if (remaining > 0) {
        // Metadata alone is not proof of a full refund; account for manual/partial refunds too.
        const refund = await provider().refunds.create({ payment_intent: intent, amount: remaining, metadata: { bookingId: booking.id } }, { idempotencyKey: `geobook-refund-${booking.id}` });
        if (refundBalance([refund], intent, { ...booking, total_cents: remaining }) !== 0) throw new HttpError(503, 'Sandbox refund is incomplete; operator reconciliation is required.');
      }
      status = 'refunded';
    } else if (cancel && current.status === 'complete' && status === 'pending') {
      throw new HttpError(503, 'Sandbox payment is still processing. Retry cancellation later.');
    }
    // A late event must never undo a completed refund.
    await client.query("UPDATE sandbox_payments SET status=$1 WHERE booking_id=$2 AND status<>'refunded'", [status, booking.id]);
    return status;
  }
  async function cancel(client: PoolClient, booking: any) {
    const result = await client.query('SELECT * FROM sandbox_payments WHERE booking_id=$1', [booking.id]);
    if (!result.rowCount || result.rows[0].status === 'refunded' || result.rows[0].status === 'expired') return;
    await sync(client, booking, await session(client, booking, result.rows[0]), true);
  }
  function webhook(app: Express) {
    app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '256kb' }), route(async (req, res) => {
      const api = provider();
      let event: Stripe.Event;
      try { event = api.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', process.env.STRIPE_WEBHOOK_SECRET || ''); }
      catch { throw new HttpError(400, 'Invalid payment webhook.'); }
      if (event.livemode !== false || event.account) throw new HttpError(400, 'Only direct-account sandbox events are supported.');
      if (!['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) { res.json({ received: true }); return; }
      if (!event.id || typeof event.id !== 'string') throw new HttpError(400, 'Missing event identifier.');
      const incoming = event.data.object as Stripe.Checkout.Session;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        const receipt = await client.query('INSERT INTO payment_webhook_receipts(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id', [event.id]);
        if (!receipt.rowCount) { await client.query('COMMIT'); res.json({ received: true }); return; }
        let result = await client.query('SELECT b.* FROM bookings b JOIN sandbox_payments p ON p.booking_id=b.id WHERE p.session_id=$1 FOR UPDATE OF b', [incoming.id]);
        if (!result.rowCount) {
          const reference = z.uuid().safeParse(incoming.client_reference_id);
          if (reference.success) {
            result = await client.query('SELECT b.* FROM bookings b JOIN sandbox_payments p ON p.booking_id=b.id WHERE b.id=$1 AND p.session_id IS NULL FOR UPDATE OF b', [reference.data]);
          }
          if (!result.rowCount) { await client.query('COMMIT'); res.json({ received: true }); return; }
          const payment = (await client.query('SELECT * FROM sandbox_payments WHERE booking_id=$1', [result.rows[0].id])).rows[0];
          const recovered = await session(client, result.rows[0], payment);
          if (recovered.id !== incoming.id) throw new HttpError(409, 'Checkout does not match the recorded payment intent.');
        }
        // Retrieve authoritative state so duplicate or reordered events are harmless.
        const current = await provider().checkout.sessions.retrieve(incoming.id);
        await sync(client, result.rows[0], current, result.rows[0].status === 'cancelled');
        await client.query('COMMIT'); res.json({ received: true });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }));
  }
  function routes(app: Express) {
    app.get('/api/payments/config', (_req, res) => { res.json({ enabled: !!stripe, sandbox: true }); });
    app.post('/api/bookings/:id/checkout', route(async (req, res) => {
      const currentUser = user(res), id = z.uuid().parse(req.params.id); provider();
      const client = await pool.connect();
      try {
        // Persist intent before contacting Stripe, including when an API response is lost.
        await client.query('BEGIN');
        const owned = await client.query("SELECT * FROM bookings WHERE id=$1 AND user_id=$2 AND demo AND status='confirmed' AND lower(stay)>CURRENT_DATE FOR UPDATE", [id, currentUser.id]);
        if (!owned.rowCount) throw new HttpError(404, 'Eligible demo reservation not found.');
        if (owned.rows[0].total_cents > 99999999) throw new HttpError(400, 'Reservation exceeds the sandbox checkout limit.');
        await client.query('INSERT INTO sandbox_payments(booking_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
        await client.query('COMMIT');
        await client.query('BEGIN');
        const booking = (await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (booking.status !== 'confirmed') throw new HttpError(409, 'Reservation has been cancelled.');
        const payment = (await client.query('SELECT * FROM sandbox_payments WHERE booking_id=$1', [id])).rows[0];
        const checkout = await session(client, booking, payment);
        const status = await sync(client, booking, checkout, false);
        await client.query('COMMIT');
        res.json({ status, url: status === 'pending' && checkout.status === 'open' ? checkoutUrl(checkout.url) : null });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }));
  }
  return { cancel, webhook, routes };
}
export type Payments = ReturnType<typeof payments>;
