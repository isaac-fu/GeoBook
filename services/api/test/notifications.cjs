const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');
const { Kafka, logLevel } = require('kafkajs');
const { migrate } = require('../dist/migrate.js');
async function main() {
  const id = randomUUID().replaceAll('-', ''); const schema = 'geobook_test_' + id; const topic = 'geobook-test-' + id;
  assert.match(schema, /^geobook_test_[a-f0-9]{32}$/);
  const connectionString = process.env.DATABASE_URL || 'postgres://geobook:geobook@127.0.0.1:5432/geobook';
  const root = new Pool({ connectionString });
  const pg = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
  const kafka = new Kafka({ brokers: (process.env.KAFKA_BROKERS || '127.0.0.1:9092').split(','), logLevel: logLevel.NOTHING, retry: { retries: 2 } });
  const admin = kafka.admin(), producer = kafka.producer(); let child, created = false, connected = false;
  try {
    await root.query('CREATE SCHEMA "' + schema + '"'); created = true; await migrate(pg);
    await admin.connect(); connected = true; await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] });
    const user = (await pg.query("INSERT INTO users(email,password_hash,name) VALUES('notification@example.test','not-a-login','Test User') RETURNING id")).rows[0];
    const payload = { userId: user.id, bookingId: randomUUID(), message: 'Isolated notification test' };
    const outbox = (await pg.query("INSERT INTO outbox(event_type,payload) VALUES('booking.created',$1) RETURNING id", [JSON.stringify(payload)])).rows[0];
    const workerUrl = new URL(connectionString); workerUrl.searchParams.set('options', '-c search_path=' + schema + ',public');
    child = spawn(process.execPath, [path.resolve(__dirname, '../../worker/dist/worker.js')], { windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, DATABASE_URL: workerUrl.toString(), KAFKA_TOPIC: topic, KAFKA_GROUP_ID: topic } });
    let logs = ''; child.stdout.on('data', b => { logs += b.toString(); }); child.stderr.on('data', b => { logs += b.toString(); });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if ((await pg.query('SELECT 1 FROM notifications WHERE event_id=$1',[outbox.id])).rowCount) break;
      if (child.exitCode !== null) throw new Error('Worker stopped: ' + logs.slice(-1500));
      await new Promise(r => setTimeout(r,300));
    }
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n,1,'Kafka notification not delivered');
    assert.ok((await pg.query('SELECT published_at FROM outbox WHERE id=$1',[outbox.id])).rows[0].published_at);
    await producer.connect(); await producer.send({ topic, messages: [{ value: JSON.stringify({ eventId: outbox.id,type:'booking.created',...payload }) }] });
    await new Promise(r => setTimeout(r,1500));
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n,1,'Duplicate event created duplicate notification');
    console.log('PASS: transactional outbox published to Kafka, consumed into notifications, duplicate event remained idempotent.');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise(r => child.once('close',r)); }
    await producer.disconnect().catch(() => {});
    if (connected) { await admin.deleteTopics({ topics:[topic] }).catch(() => {}); await admin.disconnect(); }
    await pg.end(); if (created) await root.query('DROP SCHEMA "' + schema + '" CASCADE'); await root.end();
  }
}
main().catch(e => { console.error(e); process.exitCode=1; });
