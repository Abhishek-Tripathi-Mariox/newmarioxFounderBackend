/**
 * LEGACY — Postgres connection still imported by the modules that are not ported to MongoDB yet
 * (none of them is mounted; see docs/MONGO.md "Port status"). Delete this file, knexfile.js,
 * src/db/migrations and the knex / pg dependencies once the last module is ported.
 */
import knexFactory from 'knex';
import pg from 'pg';
import { config } from '../config/index.js';

// Return NUMERIC / BIGINT as JS numbers (values here are money and hours, well inside 2^53)
// and DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(1082, (v) => v); // date

/** Shared Knex instance (connection pool) for the whole app. */
export const db = knexFactory({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: {
    min: 0,
    max: config.db.poolMax,
    // Same business time zone in SQL (now()::date, date_trunc) as in Node.
    afterCreate: (conn, done) => conn.query(`set time zone '${config.timeZone.replace(/'/g, '')}'`, (err) => done(err, conn)),
  },
});

/** Run `fn(trx)` in a transaction; commits on success, rolls back on throw. */
export const tx = (fn) => db.transaction(fn);
