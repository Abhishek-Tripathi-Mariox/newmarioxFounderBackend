#!/usr/bin/env node
/**
 * One-shot, re-runnable migration of the old apps' live data into Mariox One — runbook: docs/MIGRATION.md.
 *
 *   npm run migrate:legacy -- --dry-run                 read + map + report, write nothing
 *   npm run migrate:legacy -- --yes                     real run (--yes needed when the target already has data)
 *   npm run migrate:legacy -- --only=portal,hq          some sources only (portal, partners, hq)
 *   npm run migrate:legacy -- --dry-run --report=r.json also save the report as JSON
 *
 * Sources (read only): LEGACY_PORTAL_PG_URL, LEGACY_PARTNERS_MONGO_URI, LEGACY_HQ_MONGO_URI.
 * Target: MONGODB_URI. Exit code: 0 = done, 2 = done but some records were skipped (see the problems
 * list), 1 = fatal (bad configuration, connection or unexpected error; nothing more is written).
 */
import { writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { connectMongo, disconnectMongo } from '../src/db/mongo.js';
import { maskUri, mongoDbName, parseArgs, readLegacyEnv } from './legacy/env.js';
import { runMigration, targetDocumentCount } from './legacy/index.js';
import { knexPortalReader } from './legacy/portal.js';

const out = (msg = '') => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`\nmigrate-legacy: ${msg}\n`);
  process.exitCode = 1;
};

/** Never let a URI with credentials reach the terminal through an error message. */
const scrub = (text, uris) => uris.filter(Boolean).reduce((s, u) => s.split(u).join(maskUri(u)), String(text));

async function main() {
  const argv = process.argv.slice(2);
  const reportArg = argv.find((a) => a.startsWith('--report='));
  const args = parseArgs(argv.filter((a) => !a.startsWith('--report=')));
  if (args.help) {
    out('Usage: npm run migrate:legacy -- [--dry-run] [--yes] [--only=portal,partners,hq] [--report=<file.json>]   (docs/MIGRATION.md)');
    return;
  }
  if (args.errors.length) return fail(args.errors.join('\n'));

  const { errors, settings } = readLegacyEnv(process.env, { only: args.only, targetUri: config.db.url });
  if (errors.length) return fail(`configuration:\n  - ${errors.join('\n  - ')}\n(see backend/.env.example and docs/MIGRATION.md)`);
  const secrets = [settings.targetUri, settings.portalPgUrl, settings.partnersMongoUri, settings.hqMongoUri];

  out(`Mariox One legacy migration — ${args.dryRun ? 'DRY RUN (nothing is written)' : 'REAL RUN'}`);
  out(`  target:   ${maskUri(settings.targetUri)}`);
  if (settings.portalPgUrl) out(`  portal:   ${maskUri(settings.portalPgUrl)}`);
  if (settings.partnersMongoUri) out(`  partners: ${maskUri(settings.partnersMongoUri)}`);
  if (settings.hqMongoUri) out(`  hq:       ${maskUri(settings.hqMongoUri)}`);
  out(`  credentials: ${settings.legacyCredentialsKey ? 're-encrypted from LEGACY_PORTAL_CREDENTIALS_KEY to CREDENTIALS_KEY' : 'copied as stored (CREDENTIALS_KEY must equal the old portal\'s key)'}`);
  out();

  let portalReader = null;
  const conns = [];
  // No implicit collection creation: a dry run leaves the target exactly as it was.
  mongoose.set('autoCreate', false);
  try {
    await connectMongo({ uri: settings.targetUri });
    const existing = await targetDocumentCount();
    if (existing && !args.dryRun && !args.yes) {
      return fail(`the target database "${mongoDbName(settings.targetUri)}" already has data (${existing} documents in users / projects / leads / partners / HQ). Re-run with --yes to migrate into it (records are upserted by id), or use --dry-run first.`);
    }

    if (settings.portalPgUrl) {
      portalReader = knexPortalReader(settings.portalPgUrl);
      await portalReader.tables(); // connection check
    }
    const openMongo = async (uri) => {
      const c = await mongoose.createConnection(uri, { readPreference: 'primaryPreferred', autoIndex: false, autoCreate: false }).asPromise();
      conns.push(c);
      return c.db;
    };
    const partnersDb = settings.partnersMongoUri ? await openMongo(settings.partnersMongoUri) : null;
    const hqDb = settings.hqMongoUri ? await openMongo(settings.hqMongoUri) : null;

    const report = await runMigration({
      only: args.only,
      dryRun: args.dryRun,
      portalReader,
      partnersDb,
      hqDb,
      legacyCredentialsKey: settings.legacyCredentialsKey,
      log: (m) => out(`… ${m}`),
    });
    out();
    out(report.format());
    if (reportArg) {
      writeFileSync(reportArg.slice('--report='.length), JSON.stringify(report.toJSON(), null, 2));
      out(`\nReport saved to ${reportArg.slice('--report='.length)}`);
    }
    out(`\n${args.dryRun ? 'Dry run finished — nothing was written.' : 'Migration finished.'}${report.errorCount ? ` ${report.errorCount} record(s) need attention (errors above).` : ''}`);
    if (report.errorCount) process.exitCode = 2;
  } catch (err) {
    fail(scrub(err?.stack || err, secrets));
  } finally {
    await portalReader?.close().catch(() => {});
    for (const c of conns) await c.close().catch(() => {});
    await disconnectMongo().catch(() => {});
  }
}

await main();
