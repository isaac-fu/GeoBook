import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { seedDemo } from './demo.js';

const mongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017/geobook', { serverSelectionTimeoutMS: 5000 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://geobook:geobook@localhost:5432/geobook', connectionTimeoutMillis: 5000 });
async function main() {
  await migrate(pool);
  await mongo.connect();
  await mongo.db('geobook').collection('hotels').createIndex({ location: '2dsphere' });
  if (process.env.SEED_DEMO === 'true') await seedDemo(pool, mongo);
  const server = createApp(mongo, pool).listen(Number(process.env.PORT ?? 4000), () => console.log('GeoBook API ready'));
  const shutdown = () => { server.close(() => { Promise.all([pool.end(), mongo.close()]).finally(() => process.exit(0)); }); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch(async error => { console.error('API startup failed:', error.message); await Promise.allSettled([pool.end(), mongo.close()]); process.exitCode = 1; });
