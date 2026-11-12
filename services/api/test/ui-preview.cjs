// Disposable local preview for manual/browser tests; never uses production tables.
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const { randomUUID } = require('node:crypto');
const { migrate } = require('../dist/migrate.js');
const { seedDemo } = require('../dist/demo.js');
const { hashPassword } = require('../dist/auth.js');
const { createApp } = require('../dist/app.js');
async function main() {
  const name = 'geobook_test_' + randomUUID().replaceAll('-','');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Set DATABASE_URL to a local test PostgreSQL instance.');
  const root = new Pool({ connectionString }), pg = new Pool({ connectionString, options: '-c search_path=' + name + ',public' });
  const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
  await root.query('CREATE SCHEMA "' + name + '"'); await mongo.connect();
  const mapped = { db: () => mongo.db(name) };
  await migrate(pg); await mapped.db().collection('hotels').createIndex({ location:'2dsphere' }); await seedDemo(pg, mapped);
  await pg.query("INSERT INTO users(email,password_hash,name,role) VALUES('preview.admin@geobook.test',$1,'Preview Admin','admin')", [await hashPassword('PreviewAdminPassword2027!')]);
  const server = createApp(mapped, pg).listen(4100, '127.0.0.1', () => console.log('Disposable preview API: http://127.0.0.1:4100'));
  let closing = false;
  async function close() { if (closing) return; closing=true; server.close(async () => { await pg.end(); await root.query('DROP SCHEMA "' + name + '" CASCADE'); await mapped.db().dropDatabase(); await root.end(); await mongo.close(); process.exit(0); }); }
  process.on('SIGTERM',close); process.on('SIGINT',close);
}
main().catch(e => { console.error(e.message); process.exit(1); });
