// Run after the API build. All writes are isolated in random test databases/schemas.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const { migrate } = require('../dist/migrate.js');
const { seedDemo } = require('../dist/demo.js');
const Stripe = require('stripe');
const { createApp } = require('../dist/app.js');

async function main() {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'geobook_test_' + suffix;
  const dbName = 'geobook_test_' + suffix;
  assert.match(schema, /^geobook_test_[a-f0-9]{32}$/);
  const connectionString = process.env.DATABASE_URL || 'postgres://geobook:geobook@127.0.0.1:5432/geobook';
  const root = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const pg = new Pool({ connectionString, options: '-c search_path=' + schema + ',public', connectionTimeoutMillis: 5000 });
  const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
  let server, created = false;
  try {
    await root.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await mongo.connect();
    const db = mongo.db(dbName); const mappedMongo = { db: () => db };
    await migrate(pg); await migrate(pg); // migration reruns must be safe
    await db.collection('hotels').createIndex({ location: '2dsphere' });
    await seedDemo(pg, mappedMongo);
    const stripeSdk = new Stripe('sk_test_local_only');
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_integration_only';
    const sessions = new Map(), refunds = []; let failRefund = false, loseCheckoutResponse = true;
    const fakeStripe = { webhooks: stripeSdk.webhooks, checkout: { sessions: {
      create: async (data, options) => {
        if (sessions.has(options.idempotencyKey)) return sessions.get(options.idempotencyKey);
        const session = { id: 'cs_test_' + randomUUID(), mode: data.mode, livemode: false, client_reference_id: data.client_reference_id, amount_total: data.line_items[0].price_data.unit_amount, currency: data.line_items[0].price_data.currency, status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/test', payment_intent: 'pi_' + randomUUID() };
        sessions.set(options.idempotencyKey, session); if (loseCheckoutResponse) { loseCheckoutResponse = false; throw Error('Simulated lost provider response'); } return session;
      },
      retrieve: async id => [...sessions.values()].find(s => s.id === id),
      expire: async id => { const s = [...sessions.values()].find(s => s.id === id); if(s.status !== 'open') throw Error('Already completed'); s.status = 'expired'; return s; },
    } }, refunds: {
      list: async ({payment_intent}) => ({ data: refunds.filter(r => r.payment_intent === payment_intent) }),
      create: async data => { if (failRefund) throw Error('Simulated refund failure'); const refund = { ...data, id: 're_' + randomUUID(), status: 'succeeded' }; refunds.push(refund); return refund; },
    } };
    const emails = []; let failMail = false;
    server = createApp(mappedMongo, pg, async message => { if (failMail) throw new Error('Simulated delivery failure'); emails.push(message); }, fakeStripe).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    async function call(path, method = 'GET', body, cookie, headers = {}) {
      const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-GeoBook-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const credentials = { email: 'guest@example.test', password: 'TestPassword!2027', name: 'Test Guest' };
    const registered = await call('/auth/register', 'POST', credentials);
    assert.equal(registered.status, 201, JSON.stringify(registered.body)); const guest = registered.cookie;
    assert.ok(guest?.startsWith('geobook_session='));
    assert.equal((await call('/auth/me', 'GET', null, guest)).body.user.email, credentials.email);
    assert.equal((await call('/auth/register', 'POST', { ...credentials, email: 'escalate@example.test', role: 'admin' })).status, 400);
    assert.equal((await call('/auth/login', 'POST', { ...credentials, password: 'IncorrectPassword1' })).status, 401);
    assert.equal((await call('/auth/login', 'POST', credentials)).status, 200);
    assert.equal((await call('/auth/login', 'POST', credentials, null, { Origin: 'https://attacker.example' })).status, 403);
    const other = await call('/auth/register', 'POST', { ...credentials, email: 'other@example.test' });
    const host = await call('/auth/register', 'POST', { ...credentials, email: 'host@example.test', role: 'hotel' });
    const secondHost = await call('/auth/register', 'POST', { ...credentials, email: 'host2@example.test', role: 'hotel' });
    const list = await call('/hotels?q=San%20Francisco'); assert.equal(list.body.meta.total, 1);
    const id = 'demo:sf-harbor-house', hotelPath = '/hotels/' + encodeURIComponent(id);
    assert.equal((await call(hotelPath)).body.data.bookingConnected, true);
    const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0,10);
    const stay = { checkIn: day(10), checkOut: day(12), guests: 2 };
    const available = await call(hotelPath + '/availability?' + new URLSearchParams(stay));
    assert.equal(available.body.rooms.length, 3); const room = available.body.rooms[0];
    const input = { ...stay, hotelId: id, roomId: room.id, requestKey: randomUUID(), expectedTotalCents: room.totalCents, guestName: 'Test Guest', specialRequests: '' };
    assert.equal((await call('/bookings','POST',input)).status, 401);
    assert.equal((await call('/bookings','POST',{ ...input, expectedTotalCents: 1 },guest)).status, 409);
    const race = await Promise.all(Array.from({ length: 8 }, (_, i) => call('/bookings','POST',{ ...input, requestKey: randomUUID() },i % 2 ? guest : other.cookie)));
    assert.equal(race.filter(r => r.status === 201).length, 1, JSON.stringify(race.map(r => r.status)));
    assert.equal(race.filter(r => r.status === 409).length, 7);
    const winner = race.find(r => r.status === 201).body.data;
    const ownerCookie = winner.user_id === registered.body.user.id ? guest : other.cookie;
    const strangerCookie = ownerCookie === guest ? other.cookie : guest;
    assert.equal((await call('/bookings/' + winner.id + '/cancel','POST',{},strangerCookie)).status, 404);
    const checkoutPath = '/bookings/' + winner.id + '/checkout';
    assert.equal((await call(checkoutPath, 'POST', {}, strangerCookie)).status, 404);
    assert.equal((await call(checkoutPath, 'POST', {}, ownerCookie)).status, 500);
    const checkouts = await Promise.all([call(checkoutPath, 'POST', {}, ownerCookie), call(checkoutPath, 'POST', {}, ownerCookie)]);
    assert.ok(checkouts.every(r => r.status === 200), JSON.stringify(checkouts));
    assert.equal(sessions.size, 1);
    const paymentSession = [...sessions.values()][0];
    assert.equal(paymentSession.amount_total, winner.total_cents);
    async function webhook(session, type = 'checkout.session.completed', valid = true) {
      const payload = JSON.stringify({ id: 'evt_' + randomUUID(), type, livemode: false, data: { object: session } });
      const signature = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: valid ? process.env.STRIPE_WEBHOOK_SECRET : 'wrong' });
      const response = await fetch(base + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
      return response.status;
    }
    assert.equal(await webhook(paymentSession, undefined, false), 400);
    paymentSession.payment_status = 'paid'; paymentSession.status = 'complete';
    paymentSession.amount_total++;
    assert.equal(await webhook(paymentSession), 409);
    paymentSession.amount_total--;
    assert.equal(await webhook(paymentSession), 200);
    assert.equal(await webhook(paymentSession, 'checkout.session.expired'), 200, 'old events use current provider state');
    assert.equal((await pg.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [winner.id])).rows[0].status, 'paid');
    failRefund = true;
    assert.equal((await call('/bookings/' + winner.id + '/cancel', 'POST', {}, ownerCookie)).status, 500);
    assert.equal((await pg.query('SELECT status FROM bookings WHERE id=$1', [winner.id])).rows[0].status, 'confirmed');
    failRefund = false;

    const replay = await call('/bookings','POST',{ ...input, requestKey: winner.request_key },ownerCookie);
    assert.equal(replay.status, 200); assert.equal(replay.body.data.id, winner.id);
    assert.equal((await call('/bookings','POST',{ ...input, requestKey: winner.request_key, guests: 1 },ownerCookie)).status,409);
    assert.equal((await call('/bookings/' + winner.id + '/review','POST',{ score: 9, body: 'A wonderful stay for testing.' },ownerCookie)).status,403);
    assert.equal((await call('/bookings/' + winner.id + '/cancel','POST',{},ownerCookie)).status,200);
    assert.equal(refunds.length, 1);
    assert.equal(await webhook(paymentSession), 200);
    assert.equal(refunds.length, 1);
    assert.equal((await pg.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [winner.id])).rows[0].status, 'refunded');
    assert.equal((await call(checkoutPath, 'POST', {}, ownerCookie)).status, 404);

    assert.equal((await call(hotelPath + '/availability?' + new URLSearchParams(stay))).body.rooms.length,3);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n,2);
    await call('/favorites/' + encodeURIComponent(id),'POST',{},guest);
    assert.equal((await call('/favorites','GET',null,guest)).body.data.length,1);
    assert.equal((await call('/favorites','GET',null,other.cookie)).body.data.length,0);
    await call('/favorites/' + encodeURIComponent(id),'DELETE',null,guest);
    assert.equal((await call('/favorites','GET',null,guest)).body.data.length,0);
    assert.equal((await call('/operator/properties','GET',null,guest)).status,403);
    const property = { name: 'Integration Demo Hotel', description: 'A fictional test property used in isolated integration tests.', city: 'Albany', province: 'New York', country: 'United States', countryCode: 'US', address: 'Demo only', location: { type: 'Point', coordinates: [-73.75,42.65] }, amenities: ['Demo Wi-Fi'], images: [], published: true };
    const added = await call('/operator/properties','POST',property,host.cookie); assert.equal(added.status,201,JSON.stringify(added.body));
    const propertyPath = '/operator/properties/' + encodeURIComponent(added.body.id);
    assert.equal((await call(propertyPath,'PUT',property,secondHost.cookie)).status,404);
    const newRoom = await call(propertyPath + '/rooms','POST',{ name:'Room 1',capacity:2,nightlyCents:10000 },host.cookie);
    assert.equal(newRoom.status,201);
    assert.equal((await call('/operator/rooms/' + newRoom.body.data.id,'PUT',{ name:'Hijacked',capacity:2,nightlyCents:1 },secondHost.cookie)).status,400);
    assert.equal((await call('/operator/rooms/' + newRoom.body.data.id,'PUT',{ name:'Hijacked',capacity:2,nightlyCents:10000 },secondHost.cookie)).status,404);
    const blocked = await call('/operator/rooms/' + newRoom.body.data.id + '/blocks','POST',stay,host.cookie); assert.equal(blocked.status,201);
    assert.equal((await call('/hotels/' + encodeURIComponent(added.body.id) + '/availability?' + new URLSearchParams(stay))).body.status,'sold_out');
    const owners = await call('/operator/properties','GET',null,host.cookie); const blockId = owners.body.data[0].rooms[0].blocks[0].id;
    await call('/operator/blocks/' + blockId,'DELETE',null,host.cookie);
    assert.equal((await call('/hotels/' + encodeURIComponent(added.body.id) + '/availability?' + new URLSearchParams(stay))).body.status,'available');
    // Plans share physical inventory and retain their booked terms after operator edits.
    const planId = randomUUID();
    const roomEdit = { name: 'Room 1', capacity: 2, nightlyCents: 10000, roomType: 'King suite', ratePlans: [{ id: planId, name: 'Breakfast stay', additionalNightlyCents: 2500, breakfastIncluded: true, minNights: 2 }] };
    const roomPath = '/operator/rooms/' + newRoom.body.data.id;
    assert.equal((await call(roomPath, 'PUT', roomEdit, host.cookie)).status, 200);
    const rateAvailabilityPath = '/hotels/' + encodeURIComponent(added.body.id) + '/availability?';
    const rates = (await call(rateAvailabilityPath + new URLSearchParams(stay))).body.rooms[0].rates;
    assert.equal(rates.length, 2); assert.equal(rates[1].totalCents, 25000);
    assert.equal((await call(rateAvailabilityPath + new URLSearchParams({ ...stay, checkOut: day(11) }))).body.rooms[0].rates.length, 1);
    const rateInput = { ...input, hotelId: added.body.id, roomId: newRoom.body.data.id, ratePlanId: planId, expectedTotalCents: 25000, requestKey: randomUUID() };
    assert.equal((await call('/bookings', 'POST', { ...rateInput, expectedTotalCents: 20000 }, guest)).status, 409);
    assert.equal((await call('/bookings', 'POST', { ...rateInput, ratePlanId: randomUUID() }, guest)).status, 409);
    assert.equal((await call('/bookings', 'POST', { ...rateInput, checkOut: day(11), expectedTotalCents: 12500 }, guest)).status, 409);
    const rateBooking = await call('/bookings', 'POST', rateInput, guest);
    assert.equal(rateBooking.status, 201, JSON.stringify(rateBooking.body));
    assert.equal(rateBooking.body.data.room_type, 'King suite');
    assert.equal(rateBooking.body.data.breakfast_included, true);
    assert.equal((await call('/bookings', 'POST', { ...rateInput, ratePlanId: 'standard' }, guest)).status, 409);
    assert.equal((await call('/bookings', 'POST', { ...rateInput, requestKey: randomUUID(), ratePlanId: 'standard', expectedTotalCents: 20000 }, other.cookie)).status, 409);
    assert.equal((await call(roomPath, 'PUT', { ...roomEdit, roomType: 'Twin', ratePlans: [] }, host.cookie)).status, 200);
    const rateReplay = await call('/bookings', 'POST', rateInput, guest);
    assert.equal(rateReplay.status, 200); assert.equal(rateReplay.body.data.rate_plan_name, 'Breakfast stay');
    assert.equal(rateReplay.body.data.room_type, 'King suite');
    assert.equal((await call('/bookings/' + rateBooking.body.data.id + '/checkout', 'POST', {}, guest)).status, 200);
    assert.equal((await call('/bookings/' + rateBooking.body.data.id + '/cancel', 'POST', {}, guest)).status, 200);
    assert.equal((await pg.query('SELECT status FROM sandbox_payments WHERE booking_id=$1', [rateBooking.body.data.id])).rows[0].status, 'expired');

    assert.equal((await call('/bookings', 'POST', { ...rateInput, requestKey: randomUUID() }, guest)).status, 409);
    const pastBooking = await pg.query("INSERT INTO bookings(user_id,hotel_id,room_id,stay,total_cents,hotel_name,room_name,demo) VALUES($1,$2,$3,daterange(CURRENT_DATE-5,CURRENT_DATE-3,'[)'),10000,'Demo','Test room',true) RETURNING id", [registered.body.user.id,id,room.id]);
    assert.equal((await call('/bookings/' + pastBooking.rows[0].id + '/review','POST',{ score: 9, body: 'Completed stay review used for testing.' },guest)).status,201);
    assert.equal((await call('/bookings/' + pastBooking.rows[0].id + '/review','POST',{ score: 9, body: 'Duplicate completed stay review.' },guest)).status,409);
    assert.equal((await call(hotelPath)).body.data.rating.score,9);
    assert.equal((await call('/admin/overview','GET',null,guest)).status,403);
    await pg.query("UPDATE users SET role='admin' WHERE id=$1",[other.body.user.id]);
    assert.equal((await call('/admin/overview','GET',null,other.cookie)).status,200);
    await call('/admin/hotels/' + encodeURIComponent(added.body.id),'PATCH',{ active:false },other.cookie);
    assert.equal((await call('/hotels/' + encodeURIComponent(added.body.id))).status,404);
    await call(propertyPath,'PUT',property,host.cookie);
    assert.equal((await call('/hotels/' + encodeURIComponent(added.body.id))).status,404,'operator must not undo moderation');
    // Account email delivery is captured in memory; no email leaves the test.
    const recover = await call('/auth/register', 'POST', { ...credentials, email: 'recover@example.test' });
    const recoverCookie = recover.cookie;
    const tokenFrom = message => message.text.match(/#\/(?:verify-email|reset-password)\/([a-f0-9]{64})/)[1];
    async function waitEmail(count) {
      const deadline = Date.now() + 5000;
      while (emails.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(emails.length, count); return emails[count - 1];
    }
    assert.equal((await call('/account/verification-email', 'POST', {}, recoverCookie)).status, 200);
    const verification = tokenFrom(await waitEmail(1));
    assert.equal((await pg.query('SELECT token_hash FROM account_tokens WHERE user_id=$1', [recover.body.user.id])).rows.some(r => r.token_hash === verification), false);
    await call('/account/verification-email', 'POST', {}, recoverCookie);
    assert.equal(emails.length, 1, 'resend cooldown');
    assert.equal((await call('/auth/reset-password', 'POST', { token: verification, newPassword: 'ReplacementPassword2027!' })).status, 400);
    assert.equal((await call('/auth/verify-email', 'POST', { token: verification })).status, 200);
    assert.equal((await call('/auth/verify-email', 'POST', { token: verification })).status, 400);
    assert.ok((await call('/auth/me', 'GET', null, recoverCookie)).body.user.email_verified_at);
    const known = await call('/auth/forgot-password', 'POST', { email: 'recover@example.test' });
    const unknown = await call('/auth/forgot-password', 'POST', { email: 'missing@example.test' });
    assert.equal(known.status, 202); assert.deepEqual(known.body, unknown.body);
    const resetToken = tokenFrom(await waitEmail(2));
    assert.equal((await call('/auth/reset-password', 'POST', { token: resetToken, newPassword: 'short' })).status, 400);
    const resetResults = await Promise.all(Array.from({ length: 2 }, () => call('/auth/reset-password', 'POST', { token: resetToken, newPassword: 'ReplacementPassword2027!' })));
    assert.deepEqual(resetResults.map(r => r.status).sort(), [200, 400]);
    assert.equal((await call('/auth/me', 'GET', null, recoverCookie)).body.user, null);
    assert.equal((await call('/auth/login', 'POST', { email: 'recover@example.test', password: credentials.password })).status, 401);
    assert.equal((await call('/auth/login', 'POST', { email: 'recover@example.test', password: 'ReplacementPassword2027!' })).status, 200);
    await call('/auth/forgot-password', 'POST', { email: 'recover@example.test' });
    const expired = tokenFrom(await waitEmail(3));
    await pg.query("UPDATE account_tokens SET expires_at=now()-interval '1 minute',created_at=now()-interval '2 minutes' WHERE user_id=$1", [recover.body.user.id]);
    assert.equal((await call('/auth/reset-password', 'POST', { token: expired, newPassword: 'ExpiredPassword2027!' })).status, 400);
    await call('/auth/forgot-password', 'POST', { email: 'recover@example.test' });
    const invalidated = tokenFrom(await waitEmail(4));
    const recoveryLogin = await call('/auth/login', 'POST', { email: 'recover@example.test', password: 'ReplacementPassword2027!' });
    assert.equal((await call('/account/password', 'POST', { currentPassword: 'ReplacementPassword2027!', newPassword: 'RotatedPassword2027!' }, recoveryLogin.cookie)).status, 200);
    assert.equal((await call('/auth/reset-password', 'POST', { token: invalidated, newPassword: 'StolenPassword2027!' })).status, 400);
    failMail = true;
    assert.equal((await call('/account/verification-email', 'POST', {}, guest)).status, 503);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM account_tokens WHERE user_id=$1', [registered.body.user.id])).rows[0].n, 0);
    failMail = false;
    assert.equal((await call('/account/verification-email', 'POST', {}, guest)).status, 200);
    const expiredVerification = tokenFrom(await waitEmail(5));
    await pg.query("UPDATE account_tokens SET expires_at=now()-interval '1 minute' WHERE user_id=$1", [registered.body.user.id]);
    assert.equal((await call('/auth/verify-email', 'POST', { token: expiredVerification })).status, 400);
    await call('/account/password','POST',{ currentPassword:credentials.password,newPassword:'ReplacementPassword2027!' },guest);
    assert.equal((await call('/auth/me','GET',null,guest)).body.user,null);
    assert.equal((await call('/auth/login','POST',credentials)).status,401);
    console.log('PASS: registration, sessions, CSRF, server prices, 8-way booking race, idempotency, cancellation, ownership, blocks, favorites, verified reviews, moderation, sandbox checkout/webhooks/refunds, room rate plans, verification/recovery, expiry/replay, concurrent resets, delivery failure, password rotation, transactional outbox.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pg.end();
    // Only the explicitly generated test namespaces are removed.
    if (created) { await root.query('DROP SCHEMA "' + schema + '" CASCADE'); await mongo.db(dbName).dropDatabase(); }
    await Promise.allSettled([root.end(), mongo.close()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
