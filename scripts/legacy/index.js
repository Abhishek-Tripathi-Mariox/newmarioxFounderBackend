/**
 * Legacy data migration: internal portal (Postgres) + Mariox Partners (mariox-saas Mongo) + Founders HQ
 * (CofounderMariox Mongo) → Mariox One (the mongoose connection's database). CLI: scripts/migrate-legacy.js,
 * runbook: docs/MIGRATION.md.
 *
 * Order: portal (accounts, roles, all business data) → counters advanced past the migrated ids →
 * Founders HQ (founders linked to / created as portal accounts) → partners (partner accounts created,
 * partner admins linked). Every step upserts by id / natural key, so a re-run updates instead of
 * duplicating. A dry run reads, maps and validates everything and writes nothing.
 */
import mongoose from 'mongoose';
import { ensureIndexes } from '../../src/db/mongo.js';
import { AccountDirectory } from './accounts.js';
import { migrateHq } from './hq.js';
import { migratePartners } from './partners.js';
import { advanceCounters, migratePortal } from './portal.js';
import { Report } from './report.js';

/** Collections whose content means "this Mariox One database is in use". */
const DATA_COLLECTIONS = ['users', 'projects', 'leads', 'members', 'pp_users', 'hq_users', 'hq_workspaces'];

/** Documents in the target's main collections (0 = empty / fresh database). */
export async function targetDocumentCount() {
  let n = 0;
  for (const c of DATA_COLLECTIONS) n += await mongoose.connection.collection(c).estimatedDocumentCount();
  return n;
}

/**
 * @param {object} opts
 * @param {string[]} opts.only               sources to migrate ('portal' | 'partners' | 'hq')
 * @param {boolean} opts.dryRun
 * @param {import('./portal.js').PortalReader} [opts.portalReader]
 * @param {import('mongodb').Db} [opts.partnersDb]
 * @param {import('mongodb').Db} [opts.hqDb]
 * @param {Buffer|null} [opts.legacyCredentialsKey]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Report>}
 */
export async function runMigration({ only, dryRun, portalReader, partnersDb, hqDb, legacyCredentialsKey = null, log = () => {} }) {
  const report = new Report({ dryRun });
  if (!dryRun) await ensureIndexes(); // unique indexes are what make re-runs safe
  const directory = await new AccountDirectory({ dryRun }).load();

  if (only.includes('portal')) {
    const { sequences } = await migratePortal({ reader: portalReader, report, dryRun, directory, legacyCredentialsKey, log });
    log('counters');
    await advanceCounters({ sequences, dryRun, report });
  }
  if (only.includes('hq')) await migrateHq({ db: hqDb, report, dryRun, directory, log });
  if (only.includes('partners')) await migratePartners({ db: partnersDb, report, dryRun, directory, log });
  return report;
}
