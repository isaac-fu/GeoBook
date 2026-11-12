import { Pool } from 'pg';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../src/auth.ts';
// Run with tsx (imports in src use emitted .js paths).
async function main() {
const email = z.email().parse(process.env.ADMIN_EMAIL).toLowerCase();
const password = z.string().min(12).max(128).parse(process.env.ADMIN_PASSWORD);
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://geobook:geobook@localhost:5432/geobook' });
try {
  const existing = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (existing.rowCount) {
    if (!await verifyPassword(password, existing.rows[0].password_hash)) throw new Error('Existing account password does not match; no changes made.');
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [existing.rows[0].id]);
  } else {
    await pool.query("INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,'Administrator','admin')", [email, await hashPassword(password)]);
  }
  console.log('Administrator account ready.');
} finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
