// Run after the API build. All writes are isolated in random test databases/schemas.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const { migrate } = require('../dist/migrate.js');
const { seedDemo } = require('../dist/demo.js');
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
    server = createApp(mappedMongo, pg).listen(0, '127.0.0.1');
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
    const replay = await call('/bookings','POST',{ ...input, requestKey: winner.request_key },ownerCookie);
    assert.equal(replay.status, 200); assert.equal(replay.body.data.id, winner.id);
    assert.equal((await call('/bookings','POST',{ ...input, requestKey: winner.request_key, guests: 1 },ownerCookie)).status,409);
    assert.equal((await call('/bookings/' + winner.id + '/review','POST',{ score: 9, body: 'A wonderful stay for testing.' },ownerCookie)).status,403);
    assert.equal((await call('/bookings/' + winner.id + '/cancel','POST',{},ownerCookie)).status,200);
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
    await call('/account/password','POST',{ currentPassword:credentials.password,newPassword:'ReplacementPassword2027!' },guest);
    assert.equal((await call('/auth/me','GET',null,guest)).body.user,null);
    assert.equal((await call('/auth/login','POST',credentials)).status,401);
    console.log('PASS: registration, sessions, CSRF, server prices, 8-way booking race, idempotency, cancellation, ownership, blocks, favorites, verified reviews, moderation, password rotation, transactional outbox.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pg.end();
    // Only the explicitly generated test namespaces are removed.
    if (created) { await root.query('DROP SCHEMA "' + schema + '" CASCADE'); await mongo.db(dbName).dropDatabase(); }
    await Promise.allSettled([root.end(), mongo.close()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
