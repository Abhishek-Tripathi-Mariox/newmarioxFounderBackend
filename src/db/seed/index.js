/**
 * `npm run seed`: base data (roles, master lists, settings) + the first Super Admin (and, when
 * configured, the Founders HQ Founder seat — firstAccounts.js), into the database named in
 * MONGODB_URI; seat holders get their lead-owner profile. Idempotent — never overwrites existing
 * data or passwords.
 */
import { connectMongo, disconnectMongo, ensureIndexes } from '../mongo.js';
import { seedBase } from './base.js';
import { createSuperAdmin } from './superAdmin.js';
import { createFounder } from './firstAccounts.js';
import { ensureFounderOwners } from '../../modules/people/founderOwners.js';

try {
  const conn = await connectMongo();
  await ensureIndexes();
  await seedBase();
  await createSuperAdmin();
  await createFounder();
  await ensureFounderOwners(); // the founders own leads (sales-owner profiles)
  console.log(`Seeded ${conn.name}.`);
} catch (err) {
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnectMongo();
}
