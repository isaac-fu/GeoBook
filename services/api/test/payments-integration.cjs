// PostgreSQL-only payment regression suite. No Stripe network calls or real charges.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const Stripe = require('stripe');
const { Pool } = require('pg');
const { migrate } = require('../dist/migrate.js');
const { payments } = require('../dist/payments.js');
const { errors } = require('../dist/http.js');
const { registerBookings } = require('../dist/bookings.js');

async function main() {
  assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to a local test database.');
  const schema = 'geobook_test_' + randomUUID().replaceAll('-', '');
  const root = new Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=' + schema + ',public' });
  let server, created = false;
  try {
    await root.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await migrate(pool); await migrate(pool);
    const owner = (await pool.query("INSERT INTO users(email,password_hash) VALUES('payment@test.invalid','unused') RETURNING id")).rows[0].id;
    const booking = (await pool.query("INSERT INTO bookings(user_id,hotel_id,room_id,stay,total_cents,demo) VALUES($1,'demo:test',$2,daterange(CURRENT_DATE+10,CURRENT_DATE+12,'[)'),10000,true) RETURNING *", [owner, randomUUID()])).rows[0];
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_disposable_payment_test';
    const sdk = new Stripe('sk_test_not_a_real_key');
    const sessions = new Map(), refunds = [];
    let loseResponse = true, retrieveCalls = 0, pages = 0, loseRefundResponse = true;
    const fake = { webhooks: sdk.webhooks, checkout: { sessions: {
      create: async (data, options) => {
        if (sessions.has(options.idempotencyKey)) return sessions.get(options.idempotencyKey);
        const session = { id: 'cs_test_' + randomUUID(), livemode: false, mode: 'payment', client_reference_id: data.client_reference_id, amount_total: data.line_items[0].price_data.unit_amount, currency: 'usd', status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/test', payment_intent: 'pi_test' };
        sessions.set(options.idempotencyKey, session);
        if (loseResponse) { loseResponse = false; throw Error('Lost checkout response'); }
        return session;
      },
      retrieve: async id => { retrieveCalls++; return [...sessions.values()].find(s => s.id === id); },
      expire: async id => { const s = [...sessions.values()].find(s => s.id === id); s.status = 'expired'; return s; },
    } }, refunds: {
      list: async params => { pages++; const offset = params.starting_after ? refunds.findIndex(r => r.id === params.starting_after) + 1 : 0; return { data: refunds.slice(offset, offset + 1), has_more: offset + 1 < refunds.length }; },
      create: async (data, options) => {
        const existing = refunds.find(r => r.key === options.idempotencyKey); if (existing) return existing;
        const result = { ...data, id: 're_' + randomUUID(), key: options.idempotencyKey, currency: 'usd', status: 'succeeded' }; refunds.push(result);
        if (loseRefundResponse) { loseRefundResponse = false; throw Error('Lost refund response'); }
        return result;
      },
    } };
    const payment = payments(pool, fake), app = express(); payment.webhook(app);
    app.use(express.json());
    app.use((req, res, next) => { if (req.get('x-test-user')) res.locals.user = { id: req.get('x-test-user') }; next(); });
    payment.routes(app); registerBookings(app, pool, {}, payment); app.use(errors);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const checkout = '/api/bookings/' + booking.id + '/checkout';
    async function post(path, id = owner) { return fetch(base + path, { method: 'POST', headers: { 'x-test-user': id } }); }
    async function hook(session, id = 'evt_' + randomUUID(), extra = {}, timestamp = Math.floor(Date.now()/1000), secret = process.env.STRIPE_WEBHOOK_SECRET) {
      const payload = JSON.stringify({ id, type: 'checkout.session.completed', livemode: false, data: { object: session }, ...extra });
      const signature = sdk.webhooks.generateTestHeaderString({ payload, secret, timestamp });
      return fetch(base + '/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
    }
    assert.equal((await post(checkout, '')).status, 401);
    assert.equal((await post(checkout, randomUUID())).status, 404);
    assert.equal((await post(checkout)).status, 500);
    const session = [...sessions.values()][0];
    assert.equal((await hook(session, undefined, {}, 1)).status, 400);
    assert.equal((await hook(session, undefined, {}, undefined, 'whsec_wrong')).status, 400);
    assert.equal((await hook(session, undefined, { livemode: true })).status, 400);
    assert.equal((await hook(session, undefined, { account: 'acct_other' })).status, 400);
    session.status = 'complete'; session.payment_status = 'paid';
    const event = 'evt_' + randomUUID();
    session.amount_total++;
    assert.equal((await hook(session, event)).status, 409);
    assert.equal((await pool.query('SELECT 1 FROM payment_webhook_receipts WHERE event_id=$1', [event])).rowCount, 0);
    session.amount_total--;
    const delivered = await Promise.all(Array.from({ length: 6 }, () => hook(session, event)));
    assert.ok(delivered.every(r => r.status === 200)); assert.equal(sessions.size, 1);
    assert.equal((await pool.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [booking.id])).rows[0].status, 'paid');
    const calls = retrieveCalls; assert.equal((await hook(session, event)).status, 200); assert.equal(retrieveCalls, calls);
    assert.equal((await hook(session, undefined, { type: 'checkout.session.expired' })).status, 200);
    assert.equal((await hook({ ...session, id: 'cs_unrelated', client_reference_id: randomUUID() })).status, 200);
    refunds.push({ id: 're_manual1', payment_intent: 'pi_test', amount: 2000, currency: 'usd', status: 'pending', metadata: { bookingId: booking.id } });
    const cancelPath = '/api/bookings/' + booking.id + '/cancel';
    assert.equal((await post(cancelPath)).status, 503);
    refunds[0].status = 'succeeded';
    refunds.push({ ...refunds[0], id: 're_manual2', amount: 1000, metadata: {} });
    assert.equal((await post(cancelPath)).status, 500, 'lost refund response leaves reservation intact');
    assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1', [booking.id])).rows[0].status, 'confirmed');
    assert.equal(refunds[2].amount, 7000);
    assert.equal((await post(cancelPath)).status, 200);
    assert.ok(pages >= 4); assert.equal(refunds.length, 3);
    assert.equal((await hook(session)).status, 200); assert.equal(refunds.length, 3);
    assert.equal((await pool.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [booking.id])).rows[0].status, 'refunded');
    assert.equal((await post(checkout)).status, 404);
    const second = (await pool.query("INSERT INTO bookings(user_id,hotel_id,room_id,stay,total_cents,demo) VALUES($1,'demo:test',$2,daterange(CURRENT_DATE+10,CURRENT_DATE+12,'[)'),10000,true) RETURNING id", [owner, randomUUID()])).rows[0].id;
    const secondCheckout = '/api/bookings/' + second + '/checkout';
    const concurrentCheckouts = await Promise.all(Array.from({ length: 4 }, () => post(secondCheckout)));
    assert.ok(concurrentCheckouts.every(r => r.status === 200)); assert.equal(sessions.size, 2);
    assert.equal((await post('/api/bookings/' + second + '/cancel')).status, 200);
    assert.equal((await pool.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [second])).rows[0].status, 'expired');
    assert.equal(refunds.length, 3, 'unpaid cancellation must not create a refund');
    const unresolved = (await pool.query("INSERT INTO bookings(user_id,hotel_id,room_id,stay,total_cents,demo) VALUES($1,'demo:test',$2,daterange(CURRENT_DATE+10,CURRENT_DATE+12,'[)'),10000,true) RETURNING id", [owner, randomUUID()])).rows[0].id;
    await pool.query("INSERT INTO sandbox_payments(booking_id,created_at) VALUES($1,now()-interval '24 hours')", [unresolved]);
    assert.equal((await post('/api/bookings/' + unresolved + '/checkout')).status, 503);
    assert.equal(sessions.size, 2, 'an old unresolved intent must not risk a new Stripe session');
    console.log('PASS: ownership, raw signed webhooks, stale signatures, live/Connect rejection, lost checkout recovery, amount mismatch rollback, 6 concurrent duplicate events, reordered/unrelated events, paginated partial refunds, pending refund refusal, lost refund recovery, terminal refund state.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) await root.query('DROP SCHEMA "' + schema + '" CASCADE');
    await root.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
