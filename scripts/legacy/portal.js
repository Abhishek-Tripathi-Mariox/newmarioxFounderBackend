/**
 * Internal portal (PostgreSQL, knex) → Mariox One collections of the same names. The models in
 * src/db/models were ported 1:1 from these tables (docs/MONGO.md), so the mapping is column → field
 * with Postgres types converted the way the models store them:
 *   numeric / bigint → Number, date → 'YYYY-MM-DD', timestamptz → Date, jsonb → object/array,
 *   text[] → [String], PK column → `_id` (id / key / person_id), composite / name keys → natural-key upsert.
 * Every row goes through its mongoose model (casting, setters such as NUMERIC rounding, enum / CHECK
 * validators); a row that fails is skipped and reported. Columns Mariox One added (users.hq_seat,
 * leads.company_id …) get their defaults on insert and are never overwritten on a re-run.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import knexFactory from 'knex';
import pg from 'pg';
import mongoose from 'mongoose';
import { config } from '../../src/config/index.js';
import { normalisePerms } from '../../src/core/permissions.js';
import { SEQUENCE_STARTS, setSeq } from '../../src/db/counters.js';
import * as M from '../../src/db/models/index.js';
import { PARTNER_ROLE, SUPER_ROLE } from '../../src/db/models/roles.js';
import { ROLES } from '../../src/db/seed/base.js';
import { normEmail } from './accounts.js';

const BATCH = 1000;

/** Tables that are not migrated, and why (docs/MIGRATION.md). */
export const SKIPPED_TABLES = Object.freeze({
  refresh_tokens: 'sessions: everyone signs in again',
  presence: 'live presence / locks (ephemeral)',
  active_timers: 'running timers (ephemeral)',
  password_resets: 'one-time reset codes (ephemeral)',
  knex_migrations: 'Postgres migration bookkeeping',
  knex_migrations_lock: 'Postgres migration bookkeeping',
});

/**
 * Migrated tables in write order. `key` = natural key columns for tables without a single-column id.
 * @type {{ table: string, model: import('mongoose').Model, key?: string[] }[]}
 */
export const PORTAL_TABLES = [
  { table: 'roles', model: M.Role },
  { table: 'members', model: M.Member },
  { table: 'sales_owners', model: M.SalesOwner },
  { table: 'users', model: M.User },
  { table: 'lead_stages', model: M.LeadStage, key: ['name'] },
  { table: 'lead_sources', model: M.LeadSource, key: ['name'] },
  { table: 'services', model: M.Service, key: ['name'] },
  { table: 'settings', model: M.Setting },
  { table: 'leads', model: M.Lead },
  { table: 'lead_activities', model: M.LeadActivity },
  { table: 'quotes', model: M.Quote },
  { table: 'follow_ups', model: M.FollowUp },
  { table: 'projects', model: M.Project },
  { table: 'project_members', model: M.ProjectMember, key: ['project_id', 'member_id'] },
  { table: 'project_links', model: M.ProjectLink },
  { table: 'milestones', model: M.Milestone },
  { table: 'milestone_members', model: M.MilestoneMember, key: ['milestone_id', 'member_id'] },
  { table: 'change_requests', model: M.ChangeRequest },
  { table: 'cr_history', model: M.CrHistory },
  { table: 'tasks', model: M.Task },
  { table: 'bugs', model: M.Bug },
  { table: 'bug_events', model: M.BugEvent },
  { table: 'time_logs', model: M.TimeLog },
  { table: 'project_follow_ups', model: M.ProjectFollowUp },
  { table: 'project_integrations', model: M.ProjectIntegration },
  { table: 'project_credentials', model: M.ProjectCredential },
  { table: 'attendance_events', model: M.AttendanceEvent },
  { table: 'shift_reports', model: M.ShiftReport },
  { table: 'activity_feed', model: M.ActivityFeed },
  { table: 'audit_logs', model: M.AuditLog },
  { table: 'team_tasks', model: M.TeamTask },
  { table: 'team_task_events', model: M.TeamTaskEvent },
  { table: 'documents', model: M.Document },
];

/** Text-code counters that can be read back from ids (`MX-1043` → 1043). Base-36 user / member / role codes come from the Postgres sequences. */
const CODE_COUNTERS = [
  ['leads', 'lead_code_seq', /^MX-(\d+)$/],
  ['follow_ups', 'follow_up_code_seq', /^F(\d+)$/],
  ['project_follow_ups', 'project_follow_up_code_seq', /^PF(\d+)$/],
  ['team_tasks', 'team_task_code_seq', /^TT(\d+)$/],
  ['projects', 'project_code_seq', /^PR-(\d+)$/],
  ['tasks', 'task_code_seq', /^T(\d+)$/],
  ['bugs', 'bug_code_seq', /^BUG-(\d+)$/],
  ['time_logs', 'time_log_code_seq', /^L(\d+)$/],
];

// ---------------------------------------------------------------------------------------------
// Source readers
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} PortalReader
 * @property {() => Promise<string[]>} tables              base tables of the public schema
 * @property {(table: string) => Promise<number>} count
 * @property {(table: string, orderBy: string[], size: number) => AsyncIterable<object[]>} batches  rows, pg-parsed
 * @property {() => Promise<Record<string, number|null>>} sequences  sequence name → last value handed out (null = never)
 * @property {() => Promise<void>} close
 */

/** Postgres type parsers: NUMERIC / BIGINT as numbers, DATE as 'YYYY-MM-DD' (same as the old app's knex.js). */
const TYPES = {
  getTypeParser(oid, format) {
    if (oid === 1700 || oid === 20) return (v) => (v === null ? null : Number(v));
    if (oid === 1082) return (v) => v;
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * Read-only reader over the old portal's Postgres (every session is `read only`).
 * @param {string} url postgres://…
 * @returns {PortalReader}
 */
export function knexPortalReader(url) {
  const db = knexFactory({
    client: 'pg',
    connection: { connectionString: url, types: TYPES },
    pool: {
      min: 0,
      max: 2,
      afterCreate: (conn, done) => conn.query('set session characteristics as transaction read only', (err) => done(err, conn)),
    },
  });
  return {
    async tables() {
      const r = await db.raw("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1");
      return r.rows.map((x) => x.table_name);
    },
    async count(table) {
      const [{ n }] = await db(table).count('* as n');
      return Number(n);
    },
    async *batches(table, orderBy, size) {
      for (let offset = 0; ; offset += size) {
        const rows = await db(table).select('*').orderBy(orderBy).limit(size).offset(offset);
        if (rows.length) yield rows;
        if (rows.length < size) return;
      }
    },
    async sequences() {
      const r = await db.raw("select sequencename, last_value from pg_sequences where schemaname = 'public'");
      return Object.fromEntries(r.rows.map((x) => [x.sequencename, x.last_value == null ? null : Number(x.last_value)]));
    },
    close: () => db.destroy(),
  };
}

/**
 * In-memory reader (tests): `{ tables: { users: [rows] }, sequences: { user_code_seq: 1003 } }`.
 * @returns {PortalReader}
 */
export function memoryPortalReader({ tables = {}, sequences = {} } = {}) {
  return {
    tables: async () => Object.keys(tables),
    count: async (t) => (tables[t] || []).length,
    async *batches(t, _orderBy, size) {
      const rows = tables[t] || [];
      for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size).map((r) => structuredClone(r));
    },
    sequences: async () => ({ ...sequences }),
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
/** A Date read for a DATE column (only when no DATE parser was used): its calendar day as pg showed it. */
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Postgres array literal '{a,b}' → ['a','b'] (only when a driver handed back the raw text). */
const parsePgArray = (s) => (s === '{}' ? [] : s.replace(/^\{|\}$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));

/** Date check that also works across realms (e.g. values cloned in another VM context). */
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

/** Convert one source value for a schema path. */
export function convertValue(path, v) {
  if (v === undefined || v === null) return v;
  switch (path.instance) {
    case 'Date':
      return isDate(v) ? new Date(v.getTime()) : new Date(v);
    case 'Number':
      return typeof v === 'number' ? v : Number(v);
    case 'Boolean':
      return typeof v === 'boolean' ? v : v === 't' || v === 'true' || v === 1;
    case 'String':
      if (path.options?.match) {
        // DATE column: 'YYYY-MM-DD'
        if (isDate(v)) return dayOf(v);
        return String(v).slice(0, 10);
      }
      if (isDate(v)) return v.toISOString();
      return typeof v === 'string' ? v : String(v);
    case 'Array':
      if (typeof v === 'string') return parsePgArray(v);
      return v;
    case 'Mixed':
      if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
      return v;
    default:
      return v;
  }
}

/** PK column name of a model (`id`, `key`, `person_id`), or null for natural-key tables. */
const pkColumnOf = (model) => model.schema.path('_id')?.options?.alias ?? null;

/**
 * Map one source row through its model.
 * @returns {{ filter: object, set: object, setOnInsert: object, id: string } | { error: string, id: string }}
 */
export function mapRow(spec, row, unknownCols) {
  const { model, key } = spec;
  const pkCol = key ? null : pkColumnOf(model);
  const paths = model.schema.paths;
  const input = {};
  const given = new Set();
  for (const [col, v] of Object.entries(row)) {
    const field = col === pkCol ? '_id' : col;
    if (!paths[field] || (key && field === '_id')) {
      unknownCols.add(col);
      continue;
    }
    input[field] = convertValue(paths[field], v);
    given.add(field);
  }
  const id = key ? key.map((k) => row[k]).join('/') : String(row[pkCol]);
  if (!key && input._id == null) return { id, error: `no ${pkCol}` };
  const doc = new model(input);
  const err = doc.validateSync();
  if (err) {
    const fields = Object.values(err.errors).map((e) => `${e.path}${e.kind ? ` (${e.kind}${e.value !== undefined && typeof e.value !== 'object' ? ` "${String(e.value).slice(0, 40)}"` : ''})` : ''}`);
    return { id, error: `invalid ${fields.join(', ')}` };
  }
  const obj = doc.toObject({ virtuals: false });
  delete obj._id;
  const set = {};
  const setOnInsert = {};
  for (const [k, v] of Object.entries(obj)) (given.has(k) ? set : setOnInsert)[k] = v;
  const filter = key ? Object.fromEntries(key.map((k) => [k, obj[k]])) : { _id: input._id };
  return { id, filter, set, setOnInsert };
}

// ---------------------------------------------------------------------------------------------
// Special columns
// ---------------------------------------------------------------------------------------------

/** AES-256-GCM "v1:iv:tag:ct" (core/secretBox.js) with an explicit key. */
const sealWith = (key, plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
};
const openWith = (key, sealed) => {
  const [v, iv, tag, ct] = String(sealed).split(':');
  if (v !== 'v1') throw new Error('unknown format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
};

/** Role perms: the source's modules, plus the modules only Mariox One has (pp_*) kept from the target / built-in role. */
function mergePerms(row, existing) {
  if (row.id === SUPER_ROLE) return ROLES.find((r) => r.id === SUPER_ROLE).perms; // sees everything, incl. Mariox Partners
  const builtIn = ROLES.find((r) => r.id === row.id)?.perms || {};
  const base = existing?.perms || builtIn;
  const src = typeof row.perms === 'string' ? JSON.parse(row.perms) : row.perms || {};
  return normalisePerms({ ...base, ...src });
}

// ---------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------

/** Existing target documents among a batch (for dry-run counts). */
async function countExisting(model, mapped) {
  if (!mapped.length) return 0;
  if ('_id' in mapped[0].filter) return model.countDocuments({ _id: { $in: mapped.map((m) => m.filter._id) } });
  return model.countDocuments({ $or: mapped.map((m) => m.filter) });
}

/**
 * Upsert mapped rows; duplicate keys on other unique indexes are reported per row.
 * @returns {Promise<{ inserted: number, updated: number, unchanged: number, failed: {id: string, message: string}[] }>}
 */
async function writeBatch(model, mapped) {
  if (!mapped.length) return { inserted: 0, updated: 0, unchanged: 0, failed: [] };
  const ops = mapped.map((m) => ({
    updateOne: {
      filter: m.filter,
      update: { $set: m.set, ...(Object.keys(m.setOnInsert).length ? { $setOnInsert: m.setOnInsert } : {}) },
      upsert: true,
    },
  }));
  const failed = [];
  let res;
  try {
    res = await model.bulkWrite(ops, { ordered: false, timestamps: false, setDefaultsOnInsert: false });
  } catch (err) {
    if (!err.writeErrors && !err.result) throw err;
    for (const we of err.writeErrors || []) {
      const i = we.index ?? we.err?.index;
      const msg = (we.code ?? we.err?.code) === 11000 ? `duplicate key ${JSON.stringify(we.err?.keyValue ?? we.keyValue ?? {})}` : (we.errmsg || we.err?.errmsg || 'write failed');
      failed.push({ id: mapped[i]?.id ?? '?', message: msg });
    }
    res = err.result;
  }
  const upserted = res.upsertedCount ?? res.nUpserted ?? 0;
  const matched = res.matchedCount ?? res.nMatched ?? 0;
  const modified = res.modifiedCount ?? res.nModified ?? 0;
  return { inserted: upserted, updated: modified, unchanged: matched - modified, failed };
}

/**
 * Migrate every portal table.
 * @param {{ reader: PortalReader, report: import('./report.js').Report, dryRun: boolean, directory: import('./accounts.js').AccountDirectory, legacyCredentialsKey?: Buffer|null, log?: Function }} ctx
 */
export async function migratePortal({ reader, report, dryRun, directory, legacyCredentialsKey = null, log = () => {} }) {
  const tables = new Set(await reader.tables());
  const known = new Set([...PORTAL_TABLES.map((t) => t.table), ...Object.keys(SKIPPED_TABLES)]);
  for (const t of tables) if (!known.has(t)) report.warn('portal', t, 'table is not known to Mariox One — not migrated');
  for (const [t, why] of Object.entries(SKIPPED_TABLES)) {
    if (tables.has(t)) report.skipTable(`portal.${t}`, await reader.count(t), why);
  }

  const targetKey = config.credentialsKey;
  const reencrypt = !!legacyCredentialsKey && !!targetKey && !legacyCredentialsKey.equals(targetKey);

  for (const spec of PORTAL_TABLES) {
    const { table, model } = spec;
    const row = report.row(`portal.${table}`, model.collection.collectionName);
    if (!tables.has(table)) {
      report.warn('portal', table, 'table missing in the source database');
      continue;
    }
    log(`portal: ${table}`);
    const unknownCols = new Set();
    const orderBy = spec.key || [pkColumnOf(model)];

    // users: the email is unique (case-insensitive); a target user with the same email and another id is a conflict.
    const emailOwner = new Map();
    if (table === 'users') for (const u of directory.byId.values()) emailOwner.set(normEmail(u.email), u.id);
    const existingRoles = table === 'roles' ? new Map((await M.Role.find({}).select('perms').rows()).map((r) => [r.id, r])) : null;

    for await (const batch of reader.batches(table, orderBy, BATCH)) {
      row.read += batch.length;
      const mapped = [];
      for (const src of batch) {
        if (table === 'roles') {
          if (src.id === PARTNER_ROLE) continue; // Mariox One's own built-in role
          src.perms = mergePerms(src, existingRoles.get(src.id));
          directory.rolePerms.set(src.id, src.perms);
        }
        if (table === 'users') {
          const other = emailOwner.get(normEmail(src.email));
          if (other && other !== src.id) {
            report.error('portal.users', src.id, `email ${src.email} already belongs to target user ${other} — skipped (merge or rename one of them, then re-run)`);
            row.skipped++;
            continue;
          }
        }
        if (table === 'project_credentials' && src.value_enc) {
          if (legacyCredentialsKey) {
            try {
              const plain = openWith(legacyCredentialsKey, src.value_enc);
              if (reencrypt) {
                // Keep the ciphertext of an earlier run when it holds the same secret (a re-run changes nothing).
                const prev = (await M.ProjectCredential.findOne({ id: src.id }).select('value_enc').rows())?.value_enc;
                let same = false;
                try {
                  same = !!prev && openWith(targetKey, prev) === plain;
                } catch { /* not readable with the target key: replace it */ }
                src.value_enc = same ? prev : sealWith(targetKey, plain);
              }
            } catch {
              report.error('portal.project_credentials', src.id, 'cannot be decrypted with LEGACY_PORTAL_CREDENTIALS_KEY — copied as is');
            }
          }
        }
        // users.owner_id: a founder's lead-owner profile is linked by the HQ step (ensureFounderOwner); an empty
        // source value must not unlink it on a re-run.
        if (table === 'users' && src.owner_id == null) delete src.owner_id;
        const m = mapRow(spec, src, unknownCols);
        if (m.error) {
          report.error(`portal.${table}`, m.id, m.error);
          row.skipped++;
          continue;
        }
        mapped.push(m);
      }

      if (dryRun) {
        const existing = await countExisting(model, mapped);
        row.updated += existing;
        row.inserted += mapped.length - existing;
      } else {
        const r = await writeBatch(model, mapped);
        row.inserted += r.inserted;
        row.updated += r.updated;
        row.unchanged += r.unchanged;
        row.skipped += r.failed.length;
        for (const f of r.failed) report.error(`portal.${table}`, f.id, f.message);
      }
      if (table === 'users') {
        const failedIds = new Set(report.problems.filter((p) => p.where === 'portal.users').map((p) => p.id));
        for (const m of mapped) {
          if (failedIds.has(m.id)) continue;
          // Fields only Mariox One has (hq_seat, pp_user_id …) keep their target values; defaults only for new users.
          const known = directory.byId.has(m.filter._id);
          directory.upsert({ id: m.filter._id, ...(known ? {} : m.setOnInsert), ...m.set });
        }
      }
    }
    if (table === 'roles') await ensurePartnerRole(dryRun);
    for (const c of unknownCols) report.warn(`portal.${table}`, null, `column "${c}" has no field in Mariox One — dropped`);
  }
  return { sequences: await reader.sequences() };
}

/** The built-in Partner role must exist before partner accounts are linked to it. */
async function ensurePartnerRole(dryRun) {
  if (dryRun) return;
  const { id, ...fields } = ROLES.find((r) => r.id === PARTNER_ROLE);
  const now = new Date();
  await M.Role.updateOne({ _id: id }, { $setOnInsert: { ...fields, locked: true, created_at: now, updated_at: now } }, { upsert: true, timestamps: false });
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

/**
 * Advance every counter past the migrated ids (never moves one back):
 * text codes = max(Postgres sequence, highest code in the target), base-36 user / member / role codes =
 * the Postgres sequence, bigIncrements `<table>_id_seq` = max(Postgres sequence, highest `_id`).
 * @returns {Promise<{name: string, from: number|null, to: number}[]>}
 */
export async function advanceCounters({ sequences = {}, dryRun, report }) {
  const coll = mongoose.connection.collection('counters');
  const current = new Map((await coll.find({}).toArray()).map((c) => [c._id, c.value]));
  const wanted = new Map();
  const want = (name, v) => {
    if (v == null || Number.isNaN(v)) return;
    wanted.set(name, Math.max(wanted.get(name) ?? -Infinity, v));
  };
  for (const name of Object.keys(SEQUENCE_STARTS)) want(name, sequences[name]);
  for (const [table, name, re] of CODE_COUNTERS) {
    const ids = await mongoose.connection.collection(table).distinct('_id', { _id: { $regex: re.source } });
    for (const id of ids) want(name, Number(re.exec(id)?.[1]));
  }
  for (const spec of PORTAL_TABLES) {
    if (spec.model.schema.path('_id')?.instance !== 'Number') continue;
    const name = `${spec.table}_id_seq`;
    want(name, sequences[name]);
    const [top] = await spec.model.collection.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray();
    if (top) want(name, top._id);
  }
  const changes = [];
  for (const [name, v] of wanted) {
    const from = current.get(name) ?? null;
    const floor = (SEQUENCE_STARTS[name] ?? 1) - 1;
    if (v <= (from ?? floor)) continue;
    changes.push({ name, from, to: v });
    if (!dryRun) await setSeq(name, v);
  }
  for (const c of changes) report.counters.push(c);
  return changes;
}
