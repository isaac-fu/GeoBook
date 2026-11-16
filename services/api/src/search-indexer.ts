import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { configuredSearch, rebuildSearch } from './elastic-search.js';
async function main() {
  const elastic = configuredSearch(); if (!elastic) throw new Error('ELASTICSEARCH_URL is required');
  const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017/geobook', { serverSelectionTimeoutMS: 5000 });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  let stopping = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const stop = () => { stopping = true; if (timer) clearTimeout(timer); wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const once = process.argv.includes('--once');
  try {
    await mongo.connect();
    do {
      try { console.log('Hotel search sync:', await rebuildSearch(mongo, pool, elastic)); }
      catch (error) { console.error('Hotel search sync failed:', (error as Error).message); if (once) throw error; }
      if (!once && !stopping) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 60000); });
    } while (!once && !stopping);
  } finally { await Promise.allSettled([mongo.close(), pool.end()]); }
}
main().catch(() => { console.error('Search indexer stopped with an error'); process.exitCode = 1; });
