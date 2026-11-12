import { Kafka } from 'kafkajs';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://geobook:geobook@localhost:5432/geobook', connectionTimeoutMillis: 5000 });
const kafka = new Kafka({ clientId: 'geobook-worker', brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',') });
const producer = kafka.producer();
const topic = process.env.KAFKA_TOPIC ?? 'geobook.events';
const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID ?? 'geobook-notifications-v2' });
let stopped = false;
async function publishBatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await client.query('SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED');
    for (const row of batch.rows) {
      await producer.send({ topic, messages: [{ key: row.payload.bookingId, value: JSON.stringify({ eventId: row.id, type: row.event_type, ...row.payload }) }] });
      await client.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function main() {
  const admin = kafka.admin(); await admin.connect();
  try { await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] }); }
  finally { await admin.disconnect(); }
  await producer.connect(); await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({ eachMessage: async ({ message }) => {
    let event;
    try { event = JSON.parse(message.value?.toString() ?? '{}'); } catch { console.error('Ignored malformed event'); return; }
    if (!event.eventId || !event.userId || !event.bookingId || typeof event.message !== 'string') return;
    // Event IDs make delivery idempotent if publishing or consumption is retried.
    await pool.query('INSERT INTO notifications(event_id,user_id,booking_id,message) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING',
      [event.eventId, event.userId, event.bookingId, event.message]);
  } });
  while (!stopped) {
    try { await publishBatch(); } catch { console.error('Outbox delivery failed; will retry'); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
async function shutdown() { stopped = true; await consumer.disconnect(); await producer.disconnect(); await pool.end(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
main().catch(async error => { console.error('Worker startup failed:', error.message); await pool.end(); process.exitCode = 1; });
