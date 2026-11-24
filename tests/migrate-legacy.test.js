/**
 * Legacy data migration (scripts/migrate-legacy.js, docs/MIGRATION.md).
 *
 * Target: this run's throwaway marioxone_test_<random> database (tests/helpers.js), seeded like a fresh
 * server (`npm run seed` base data). Sources:
 *   - Mariox Partners and Founders HQ: two more throwaway Mongo databases (marioxone_test_<random>_pp / _hq)
 *     filled with documents shaped like mariox-saas / CofounderMariox data; dropped afterwards.
 *   - Internal portal (Postgres): an in-memory reader behind the same interface as the knex reader
 *     (rows as the pg driver returns them). When TEST_LEGACY_PG_URL is set (postgres://… of a server
 *     where a database may be created), the last block also runs the knex reader against a real
 *     throwaway Postgres database (marioxone_test_<random>, created from the old schema's migrations
 *     and dropped again); otherwise that block is skipped.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import request from 'supertest';
import { app, closeDb, emptyTestDb } from './helpers.js';
import { seedBase } from '../src/db/seed/base.js';
import { nextId } from '../src/core/ids.js';
import { open as openSecret } from '../src/core/secretBox.js';
import * as M from '../src/db/models/index.js';
import { runMigration } from '../scripts/legacy/index.js';
import { knexPortalReader, memoryPortalReader } from '../scripts/legacy/portal.js';
import { maskUri, parseArgs, readLegacyEnv } from '../scripts/legacy/env.js';

const { ObjectId } = mongoose.Types;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_SUFFIX = randomBytes(4).toString('hex');
const PASSWORD = 'secret123';
let HASH;

// ---- source fixtures -------------------------------------------------------------------------

const LEGACY_KEY = randomBytes(32);
const sealWith = (key, plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
};

const T0 = new Date('2026-09-01T10:00:00.000Z');
const T1 = new Date('2026-10-15T12:30:00.000Z');

function portalData() {
  const perms = (o) => o; // old matrix: no pp_* modules
  return {
    tables: {
      roles: [
        { id: 'r-super', name: 'Super Admin', description: 'All', hue: 265, locked: true, perms: perms({ leads: { v: true, c: true, e: true, d: true, scope: 'all' } }), created_at: T0, updated_at: T0 },
        { id: 'r-tl', name: 'Team Lead', description: 'Leads a team', hue: 70, locked: false, perms: perms({ projects: { v: true, c: true, e: false, d: false, scope: 'team' } }), created_at: T0, updated_at: T1 },
        { id: 'r-1a', name: 'Auditor', description: 'Custom', hue: 10, locked: false, perms: JSON.stringify({ dash: { v: true } }), created_at: T0, updated_at: T0 },
      ],
      members: [
        { id: 'mj', name: 'Meera Joshi', role_title: 'PM', team: 'PMO', hue: 300, shift_hours: 8, cost_per_hour: 450.5, active: true, legacy_col: 'x', created_at: T0, updated_at: T0 },
      ],
      sales_owners: [{ id: 'ak', name: 'Aman Kapoor', hue: 265, active: true, created_at: T0, updated_at: T0 }],
      users: [
        { id: 'u-ceo', name: 'CEO', email: 'CEO@old.io', phone: '', title: 'CEO', role_id: 'r-super', dept: 'Management', reports_to: null, join_date: '2026-01-05', status: 'Active', invited_at: null, last_active_at: T1, hue: 265, password_hash: HASH, member_id: null, owner_id: null, client_of: [], shift_hours: 8, invite_token_hash: null, invite_expires_at: null, reset_token_hash: null, reset_expires_at: null, created_at: T0, updated_at: T1 },
        { id: 'u-tl', name: 'Tara Lead', email: 'lead@old.io', phone: '', title: '', role_id: 'r-tl', dept: 'Web', reports_to: 'u-ceo', join_date: null, status: 'Active', invited_at: null, last_active_at: null, hue: 100, password_hash: HASH, member_id: 'mj', owner_id: null, client_of: [], shift_hours: 8, invite_token_hash: null, invite_expires_at: null, reset_token_hash: null, reset_expires_at: null, created_at: T0, updated_at: T0 },
        { id: 'u-dev', name: 'Dev Staff', email: 'dev@old.io', phone: '', title: '', role_id: 'r-tm', dept: 'Web', reports_to: 'u-tl', join_date: null, status: 'Invited', invited_at: T0, last_active_at: null, hue: 100, password_hash: null, member_id: null, owner_id: null, client_of: '{}', shift_hours: '7.50', invite_token_hash: 'abc', invite_expires_at: T1, reset_token_hash: null, reset_expires_at: null, created_at: T0, updated_at: T0 },
      ],
      lead_stages: [{ name: 'New', hue: 250, position: 0, is_core: true, created_at: T0, updated_at: T0 }, { name: 'Pilot', hue: 33, position: 7, is_core: false, created_at: T0, updated_at: T0 }],
      settings: [{ key: 'currency', value: 'USD', created_at: T0, updated_at: T1 }],
      leads: [
        { id: 'MX-1005', company: 'Zen', contact: 'Ankit', email: '', phone: '', services: ['Web Development'], source: 'Website', owner_id: 'ak', first_owner_id: 'ak', status: 'New', value: '125000.505', notes: '', created_at: T0, updated_at: T1 },
      ],
      quotes: [
        { id: 'Q-1005-1', lead_id: 'MX-1005', status: 'Sent', items: '[{"d":"App","q":1,"r":1000}]', discount_pct: 5, gst: true, valid_days: 15, terms: '', net: 950, total: 1121, sent_at: T1, viewed_at: null, accepted_at: null, declined_at: null, created_at: T0, updated_at: T1 },
      ],
      projects: [
        { id: 'PR-107', name: 'Alpha', client: 'Alpha Retail', services: ['Mobile App'], status: 'Running', pm_member_id: 'mj', start_date: new Date(2026, 8, 1), due_date: '2026-12-31', value: '1000000.00', hue: 220, priority: 'High', brief: '', portal_on: false, portal_token: null, client_email: null, budget_hours: null, status_reason: '', status_note: '', status_note_at: null, expected_delivery_date: null, created_at: T0, updated_at: T1 },
      ],
      project_members: [{ project_id: 'PR-107', member_id: 'mj', alloc_hours: 40, position: 0, is_primary: true }],
      bugs: [
        { id: 'BUG-1009', project_id: 'PR-107', milestone_id: null, title: 'Crash', dept: 'Mobile', env: 'Prod', severity: 'Huge', priority: 'High', status: 'Open', assignee_id: null, reporter: 'mj', reported_on: '2026-10-01', due_date: null, build: '', steps: '', expected: '', actual: '', link: '', created_at: T0, updated_at: T0 },
      ],
      project_integrations: [{ id: 4, project_id: 'PR-107', name: 'Stripe', category: 'Payments', status: 'Live', url: '', notes: '', created_by: 'u-ceo', created_at: T0, updated_at: T0 }],
      project_credentials: [{ id: 6, integration_id: 4, label: 'API key', env: 'Live', value_enc: sealWith(LEGACY_KEY, 'sk_live_123'), updated_by: 'u-ceo', position: 0, created_at: T0, updated_at: T0 }],
      shift_reports: [{ id: 7, person_id: 'mj', day: '2026-10-14', is_sales: false, done: 'x', blockers: '', plan: '', outcome: '', calls: 0, meetings: 0, rows: [{ p: 'PR-107', h: 6 }], pm_rows: [], internal_rows: [], lead_rows: [], team_tasks: [], submitted_at: T1 }],
      audit_logs: [
        { id: 3, actor_user_id: 'u-ceo', actor_name: 'CEO', text: 'invited Dev', kind: 'Invite', created_at: T0 },
        { id: 9, actor_user_id: 'u-ceo', actor_name: 'CEO', text: 'changed role', kind: 'Role', created_at: T1 },
      ],
      refresh_tokens: [{ id: 'x1' }, { id: 'x2' }],
      presence: [{ person_id: 'mj', last_activity_at: T1 }],
      legacy_stuff: [{ id: 1 }],
    },
    sequences: { audit_logs_id_seq: 12, user_code_seq: 1010, lead_code_seq: 1004, project_code_seq: 107, bug_code_seq: 1009 },
  };
}

const ids = {
  p1: new ObjectId(), p2: new ObjectId(), p3: new ObjectId(), p4: new ObjectId(), a1: new ObjectId(), a2: new ObjectId(),
  lead: new ObjectId(), project: new ObjectId(), file: new ObjectId(), rahul: new ObjectId(), saswat: new ObjectId(),
};

function partnersData() {
  const base = { commissionRate: 0.5, createdAt: T0, updatedAt: T1, __v: 0 };
  return {
    users: [
      { _id: ids.p1, name: 'Rohit', email: 'rohit@partner.io', passwordHash: HASH, role: 'partner', status: 'active', partnerCode: 'MX-P-243-1', company: 'Sharma Digital', phone: '+91 98765 43210', source: 'admin', lastLoginAt: T1, sessionVersion: 2, ...base },
      { _id: ids.p2, name: 'No Hash', email: 'nohash@partner.io', passwordHash: 'plaintext', role: 'partner', status: 'active', partnerCode: 'MX-P-243-2', source: 'main-site', ...base },
      { _id: ids.p3, name: 'Invitee', email: 'invitee@partner.io', role: 'partner', status: 'invited', partnerCode: 'MX-P-243-3', inviteToken: 'f'.repeat(64), inviteExpires: new Date(Date.now() + 864e5), source: 'admin', ...base },
      { _id: ids.p4, name: 'Dev As Partner', email: 'dev@old.io', passwordHash: HASH, role: 'partner', status: 'active', partnerCode: 'MX-P-243-4', source: 'admin', ...base },
      { _id: ids.a1, name: 'CEO', email: 'ceo@old.io', passwordHash: HASH, role: 'admin', status: 'active', source: 'admin', ...base },
      { _id: ids.a2, name: 'Tara', email: 'lead@old.io', passwordHash: HASH, role: 'admin', status: 'active', source: 'admin', ...base },
    ],
    leads: [{ _id: ids.lead, owner: ids.p1, company: 'Client Co', value: 50000, stage: 'lead', tasks: [{ _id: new ObjectId(), text: 'call', due: '2026-10-20', done: false }], activities: [], createdAt: T0, updatedAt: T1, __v: 0 }],
    projects: [{ _id: ids.project, owner: ids.p1, lead: ids.lead, client: 'Client Co', title: 'Website', deal: 50000, commissionRate: 0.5, stage: 1, milestones: ['2026-11-01'], payments: [{ _id: new ObjectId(), label: 'Advance', amount: 25000, status: 'received' }], createdAt: T0, updatedAt: T1, __v: 0 }],
    files: [{ _id: ids.file, key: 'uploads/2026-10/abc/brief.pdf', name: 'brief.pdf', size: 1234, type: 'application/pdf', owner: ids.p1, shared: false, createdAt: T0, updatedAt: T0, __v: 0 }],
    scopes: [{ _id: new ObjectId(), owner: ids.p1, client: 'Client Co', project: 'Website', attachments: [{ fileId: String(ids.file), name: 'brief.pdf', size: 1234, type: 'application/pdf' }], submitted: 50000, status: 'review', createdAt: T0, updatedAt: T0, __v: 0 }],
    tickets: [{ _id: new ObjectId(), owner: ids.p1, code: 'TK-2001', subject: 'Payout', status: 'requested', createdAt: T0, updatedAt: T0, __v: 0 }],
    acqleads: [{ _id: new ObjectId(), code: 'P-0001', name: 'Rohit', owner: 'Aman', contactedAt: '2026-09-01', status: 'converted', partner: ids.p1, steps: [{ k: 'contacted', date: '2026-09-01' }], createdAt: T0, updatedAt: T0, __v: 0 }],
    settings: [{ _id: new ObjectId(), key: 'portal', announcement: 'Hello partners', contacts: [], pipeline: { stages: [{ key: 'lead', name: 'Lead', prob: 10 }], sources: ['Referral'], priorities: [], lostReasons: [] }, createdAt: T0, updatedAt: T1, __v: 0 }],
    'uploads.files': [{ _id: new ObjectId(), filename: 'old.jpg' }],
  };
}

function hqData() {
  return {
    users: [
      { _id: ids.rahul, name: 'Rahul', email: 'ceo@OLD.io', passwordHash: HASH, seat: 'rahul', sessionVersion: 0, lastLoginAt: T1, prefs: { theme: 'dark' }, createdAt: T0, updatedAt: T1, __v: 0 },
      { _id: ids.saswat, name: 'Saswat', email: 'saswat@hq.io', passwordHash: HASH, seat: 'saswat', sessionVersion: 0, lastLoginAt: null, prefs: {}, createdAt: T1, updatedAt: T1, __v: 0 },
    ],
    workspaces: [{ _id: new ObjectId(), key: 'main', data: { tasks: [{ id: 't1', owner: 'both' }, { id: 't2', owner: 'saswat' }] }, version: 3, updatedBy: ids.rahul, createdAt: T0, updatedAt: T1, __v: 0 }],
    workspacerevisions: [1, 2, 3].map((v) => ({ _id: new ObjectId(), version: v, by: ids.rahul, at: T1 })),
    vaults: [{ _id: new ObjectId(), key: 'main', salt: 's', iv: 'i', ct: 'c', updatedBy: ids.saswat, createdAt: T0, updatedAt: T1, __v: 0 }],
  };
}

// ---- harness ---------------------------------------------------------------------------------

let ppConn;
let hqConn;

async function fillMongo(conn, data) {
  await conn.dropDatabase();
  for (const [name, docs] of Object.entries(data)) await conn.db.collection(name).insertMany(docs);
}

const run = (opts = {}) => runMigration({
  only: ['portal', 'partners', 'hq'],
  dryRun: false,
  portalReader: memoryPortalReader(portalData()),
  partnersDb: ppConn.db,
  hqDb: hqConn.db,
  legacyCredentialsKey: LEGACY_KEY,
  ...opts,
});

/** Every collection's document count + the counters (to prove a dry run writes nothing). */
async function snapshot() {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    out[name] = await mongoose.connection.collection(name).countDocuments();
  }
  out.__counters = await mongoose.connection.collection('counters').find({}).sort({ _id: 1 }).toArray();
  return out;
}

const rowOf = (report, source, target) => report.rows.get(`${source} → ${target}`);
const problemsOf = (report, where, level) => report.problems.filter((p) => p.where === where && (!level || p.level === level));

beforeAll(async () => {
  HASH = await bcrypt.hash(PASSWORD, 4);
  await emptyTestDb();
  await seedBase(); // like a fresh server after `npm run seed`
  const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
  ppConn = await mongoose.createConnection(uri, { dbName: `marioxone_test_${SRC_SUFFIX}_pp` }).asPromise();
  hqConn = await mongoose.createConnection(uri, { dbName: `marioxone_test_${SRC_SUFFIX}_hq` }).asPromise();
  await fillMongo(ppConn, partnersData());
  await fillMongo(hqConn, hqData());
});

afterAll(async () => {
  for (const c of [ppConn, hqConn]) {
    if (c) {
      await c.dropDatabase().catch(() => {});
      await c.close();
    }
  }
  await closeDb();
});

// ---- tests -----------------------------------------------------------------------------------

describe('env and flags', () => {
  test('masks passwords and query strings, never prints a full URI', () => {
    expect(maskUri('postgres://app:p@ss@word@db.example.com:5432/portal?sslmode=require')).toBe('postgres://app:***@db.example.com:5432/portal');
    expect(maskUri('mongodb+srv://u:secret@cluster0.x.mongodb.net/mariox?retryWrites=true')).toBe('mongodb+srv://u:***@cluster0.x.mongodb.net/mariox');
    expect(maskUri('mongodb://127.0.0.1:27017/founders_hq')).toBe('mongodb://127.0.0.1:27017/founders_hq');
  });

  test('validates the source variables with clear errors', () => {
    const { errors } = readLegacyEnv({ LEGACY_PARTNERS_MONGO_URI: 'mongodb://h:27017', LEGACY_HQ_MONGO_URI: 'mongodb://h:27017/app' }, { only: ['portal', 'partners', 'hq'], targetUri: 'mongodb://h:27017/app' });
    expect(errors.join('\n')).toMatch(/LEGACY_PORTAL_PG_URL is not set/);
    expect(errors.join('\n')).toMatch(/LEGACY_PARTNERS_MONGO_URI must name the database/);
    expect(errors.join('\n')).toMatch(/LEGACY_HQ_MONGO_URI points at the target database/);
    const ok = readLegacyEnv({ LEGACY_PORTAL_PG_URL: 'postgres://u:p@h/db' }, { only: ['portal'], targetUri: 'mongodb://h:27017/app' });
    expect(ok.errors).toEqual([]);
    const key = readLegacyEnv({ LEGACY_PORTAL_PG_URL: 'postgres://u:p@h/db', LEGACY_PORTAL_CREDENTIALS_KEY: 'short' }, { only: ['portal'], targetUri: 'mongodb://h:27017/app' });
    expect(key.errors.join()).toMatch(/LEGACY_PORTAL_CREDENTIALS_KEY must be 32 bytes/);
    expect(parseArgs(['--dry-run', '--only=hq,portal'])).toMatchObject({ dryRun: true, only: ['portal', 'hq'], errors: [] });
    expect(parseArgs(['--only=crm']).errors).toHaveLength(1);
  });
});

describe('dry run', () => {
  test('reads, maps and reports — and writes nothing', async () => {
    const before = await snapshot();
    const report = await run({ dryRun: true });
    expect(await snapshot()).toEqual(before);

    expect(rowOf(report, 'portal.users', 'users')).toMatchObject({ read: 3, inserted: 3, skipped: 0 });
    expect(rowOf(report, 'portal.bugs', 'bugs')).toMatchObject({ read: 1, inserted: 0, skipped: 1 });
    expect(rowOf(report, 'portal.lead_stages', 'lead_stages')).toMatchObject({ read: 2, inserted: 1, updated: 1 }); // 'New' exists (seed)
    expect(rowOf(report, 'partners.users', 'users (accounts)')).toMatchObject({ read: 6, inserted: 3, updated: 2, skipped: 1 });
    expect(rowOf(report, 'hq.users', 'users (accounts)')).toMatchObject({ read: 2, inserted: 1, updated: 1 });
    expect(report.counters.find((c) => c.name === 'user_code_seq')).toMatchObject({ to: 1010 });
  });
});

describe('real run', () => {
  let report;
  beforeAll(async () => {
    report = await run();
  });

  test('maps portal tables through the Mariox One models (types, dates, jsonb, defaults, timestamps)', async () => {
    const lead = await M.Lead.findOne({ id: 'MX-1005' }).rows();
    expect(lead).toMatchObject({ value: 125000.51, services: ['Web Development'], company_id: 'mariox', created_at: T0, updated_at: T1 });
    const quote = await M.Quote.findOne({ id: 'Q-1005-1' }).rows();
    expect(quote.items).toEqual([{ d: 'App', q: 1, r: 1000 }]); // jsonb text → array
    const project = await M.Project.findOne({ id: 'PR-107' }).rows();
    expect(project).toMatchObject({ start_date: '2026-09-01', due_date: '2026-12-31', value: 1000000, lock_version: 0, created_at: T0 });
    const member = await M.Member.findOne({ id: 'mj' }).rows();
    expect(member).toMatchObject({ cost_per_hour: 450.5, shift_hours: 8 });
    expect(member).not.toHaveProperty('legacy_col');
    const dev = await M.User.findOne({ id: 'u-dev' }).rows();
    expect(dev).toMatchObject({ client_of: [], shift_hours: 7.5, status: 'Invited', invite_token_hash: 'abc', hq_seat: null, pp_user_id: null });
    expect(await M.ProjectMember.findOne({ project_id: 'PR-107', member_id: 'mj' }).rows()).toMatchObject({ alloc_hours: 40, is_primary: true });
    expect(await M.ShiftReport.findOne({ id: 7 }).rows()).toMatchObject({ day: '2026-10-14', rows: [{ p: 'PR-107', h: 6 }] });
    expect(await M.AuditLog.findOne({ id: 9 }).rows()).toMatchObject({ kind: 'Role', created_at: T1 });
    expect(await M.Setting.findOne({ key: 'currency' }).rows()).toMatchObject({ value: 'USD' });
    expect(await M.LeadStage.countDocuments({ name: 'New' })).toBe(1);
    expect(await M.LeadStage.findOne({ name: 'Pilot' }).rows()).toMatchObject({ position: 7 });
  });

  test('roles keep their permissions and gain the Mariox One-only modules', async () => {
    const tl = await M.Role.findOne({ id: 'r-tl' }).rows();
    expect(tl.perms.projects).toMatchObject({ v: true, c: true, scope: 'team' });
    expect(tl.perms.pp_acq).toMatchObject({ v: false });
    const custom = await M.Role.findOne({ id: 'r-1a' }).rows();
    expect(custom.perms.dash.v).toBe(true);
    const sup = await M.Role.findOne({ id: 'r-super' }).rows();
    expect(sup.perms.pp_partners.v).toBe(true);
    expect(await M.Role.exists({ _id: 'r-partner' })).toBeTruthy();
  });

  test('re-encrypts project credentials with CREDENTIALS_KEY', async () => {
    const cred = await M.ProjectCredential.findOne({ id: 6 }).rows();
    expect(openSecret(cred.value_enc)).toBe('sk_live_123');
  });

  test('skips ephemeral tables and reports bad rows, unknown tables and columns', () => {
    expect(rowOf(report, 'portal.refresh_tokens', '(not migrated)')).toMatchObject({ read: 2, skipped: 2 });
    expect(rowOf(report, 'portal.presence', '(not migrated)')).toMatchObject({ read: 1, skipped: 1 });
    expect(problemsOf(report, 'portal.bugs', 'error')).toEqual([expect.objectContaining({ id: 'BUG-1009', message: expect.stringMatching(/severity/) })]);
    expect(problemsOf(report, 'portal', 'warn').map((p) => p.id)).toContain('legacy_stuff');
    expect(problemsOf(report, 'portal.members', 'warn')[0].message).toMatch(/legacy_col/);
    expect(JSON.stringify(report.toJSON())).not.toMatch(/\$2[aby]\$/); // no password hashes in the report
  });

  test('partner accounts: pp_users profile + one portal user (role Partner) with the bcrypt hash', async () => {
    const profile = await M.PpUser.findById(ids.p1).lean();
    expect(profile).toMatchObject({ email: 'rohit@partner.io', partnerCode: 'MX-P-243-1', status: 'active', createdAt: T0 });
    expect(profile).not.toHaveProperty('passwordHash');
    expect(profile).not.toHaveProperty('sessionVersion');
    const user = await M.User.findOne({ pp_user_id: String(ids.p1) }).rows();
    expect(user).toMatchObject({ email: 'rohit@partner.io', role_id: 'r-partner', status: 'Active', title: 'Partner', created_at: T0 });
    expect(await bcrypt.compare(PASSWORD, user.password_hash)).toBe(true);

  });

  test('partner without a usable hash → Invited; pending invite kept; staff email → conflict, no login', async () => {
    expect(await M.User.findOne({ pp_user_id: String(ids.p2) }).rows()).toMatchObject({ status: 'Invited', password_hash: null });
    expect(await M.PpUser.findById(ids.p2).lean()).toMatchObject({ status: 'invited' });
    expect(problemsOf(report, 'partners.users', 'warn').some((p) => p.id === 'nohash@partner.io')).toBe(true);

    expect(await M.User.findOne({ pp_user_id: String(ids.p3) }).rows()).toMatchObject({ status: 'Invited' });
    expect(await M.PpUser.findById(ids.p3).select('+inviteToken').lean()).toMatchObject({ inviteToken: 'f'.repeat(64) });

    expect(await M.PpUser.exists({ _id: ids.p4 })).toBeTruthy();
    expect(await M.User.countDocuments({ email: 'dev@old.io' })).toBe(1);
    expect(await M.User.findOne({ id: 'u-dev' }).rows()).toMatchObject({ role_id: 'r-tm', pp_user_id: null });
    expect(problemsOf(report, 'partners.users', 'error')).toEqual([expect.objectContaining({ id: 'dev@old.io', message: expect.stringMatching(/u-dev/) })]);
  });

  test('partner admins are linked to the portal user with the same email', async () => {
    expect(await M.User.findOne({ id: 'u-ceo' }).rows()).toMatchObject({ pp_user_id: String(ids.a1) });
    expect(await M.User.findOne({ id: 'u-tl' }).rows()).toMatchObject({ pp_user_id: String(ids.a2) });
    // Team Lead has no Partners permission: reported, the role is not changed.
    expect(problemsOf(report, 'partners.users', 'warn').some((p) => p.id === 'lead@old.io' && /pp_\*/.test(p.message))).toBe(true);
  });

  test('partner data keeps its _ids and references', async () => {
    expect(await M.PpLead.findById(ids.lead).lean()).toMatchObject({ owner: ids.p1, company: 'Client Co' });
    expect(await M.PpProject.findById(ids.project).lean()).toMatchObject({ owner: ids.p1, lead: ids.lead });
    expect(await M.PpFile.findById(ids.file).lean()).toMatchObject({ key: 'uploads/2026-10/abc/brief.pdf', owner: ids.p1 });
    expect(await M.PpScope.findOne({ owner: ids.p1 }).lean()).toMatchObject({ attachments: [{ fileId: String(ids.file) }] });
    expect(await M.PpTicket.findOne({ code: 'TK-2001' }).lean()).toBeTruthy();
    expect(await M.PpAcqLead.findOne({ code: 'P-0001' }).lean()).toMatchObject({ partner: ids.p1, owner: 'Aman' });
    expect(await M.PpSetting.findOne({ key: 'portal' }).lean()).toMatchObject({ announcement: 'Hello partners' });
    expect(rowOf(report, 'partners.uploads.files', '(not migrated)')).toMatchObject({ read: 1, skipped: 1 });
  });

  test('Founders HQ: seats linked to the portal account with the same email, or a new Super Admin', async () => {
    const ceo = await M.User.findOne({ id: 'u-ceo' }).rows();
    expect(ceo).toMatchObject({ hq_seat: 'rahul', hq_role: 'founder' });
    expect(await M.SalesOwner.findOne({ id: ceo.owner_id }).rows()).toMatchObject({ founder: true, name: 'CEO' });

    const saswat = await M.User.findOne({ email: 'saswat@hq.io' }).rows();
    expect(saswat).toMatchObject({ role_id: 'r-super', hq_seat: 'saswat', hq_role: 'cofounder', status: 'Active', title: 'Co-founder', created_at: T1 });
    expect(await bcrypt.compare(PASSWORD, saswat.password_hash)).toBe(true);
    expect(saswat.id).toMatch(/^u-/);

    const rec = await M.HqUser.findById(ids.rahul).select('+prefs').lean();
    expect(rec).toMatchObject({ seat: 'rahul', user_id: 'u-ceo', email: 'ceo@old.io', prefs: { theme: 'dark' } });
    const ws = await M.HqWorkspace.findOne({ key: 'main' }).lean();
    expect(ws).toMatchObject({ version: 3, updatedBy: ids.rahul, data: { tasks: [{ id: 't1', owner: 'both' }, { id: 't2', owner: 'saswat' }] } });
    expect(await M.HqWorkspaceRevision.countDocuments()).toBe(3);
    expect(await M.HqVault.findOne({ key: 'main' }).lean()).toMatchObject({ ct: 'c', updatedBy: ids.saswat });

  });

  test('counters move past the migrated ids, so new records never collide', async () => {
    const counters = Object.fromEntries((await mongoose.connection.collection('counters').find({}).toArray()).map((c) => [c._id, c.value]));
    expect(counters.audit_logs_id_seq).toBe(12);
    expect(counters.project_code_seq).toBe(107);
    expect(counters.shift_reports_id_seq).toBe(7);
    expect(counters.user_code_seq).toBeGreaterThan(1010); // the migration itself created users after 1010
    expect(await nextId('lead')).toBe('MX-1006'); // MX-1005 is higher than the Postgres sequence (1004)
    expect(await nextId('bug')).toBe('BUG-1010');
    const [audit] = await M.AuditLog.insertRows([{ actor_name: 'x', text: 'y', kind: 'Access' }]);
    expect(audit.id).toBe(13);
  });

  test('idempotent: a second run updates in place and duplicates nothing', async () => {
    const before = await snapshot();
    const users = await M.User.find({}).sort({ _id: 1 }).rows();
    const again = await run();
    const after = await snapshot();
    delete before.__counters;
    delete after.__counters;
    expect(after).toEqual(before);
    expect(await M.User.find({}).sort({ _id: 1 }).rows()).toEqual(users);
    const changed = [...again.rows.values()].filter((r) => r.inserted || r.updated).map((r) => `${r.source} → ${r.target}`);
    expect(changed).toEqual([]);
    expect(rowOf(again, 'portal.leads', 'leads')).toMatchObject({ read: 1, unchanged: 1 });
    expect(rowOf(again, 'partners.users', 'users (accounts)')).toMatchObject({ unchanged: 5, skipped: 1 });
  });

  test('a changed source record is updated on the next run (Mariox One-only fields are kept)', async () => {
    const data = portalData();
    data.tables.leads[0].status = 'Contacted';
    data.tables.users[0].name = 'Chief';
    const again = await run({ portalReader: memoryPortalReader(data), only: ['portal'] });
    expect(rowOf(again, 'portal.leads', 'leads')).toMatchObject({ updated: 1 });
    expect(await M.Lead.findOne({ id: 'MX-1005' }).rows()).toMatchObject({ status: 'Contacted', company_id: 'mariox' });
    const ceo = await M.User.findOne({ id: 'u-ceo' }).rows();
    expect(ceo).toMatchObject({ name: 'Chief', hq_seat: 'rahul', pp_user_id: String(ids.a1) });
    expect(ceo.owner_id).toBeTruthy();
  });

  test('migrated accounts sign in with their old passwords and land in the right app', async () => {
    const partner = await request(app).post('/api/v1/auth/login').send({ email: 'rohit@partner.io', password: PASSWORD });
    expect(partner.status).toBe(200);
    expect(partner.body.data.user.apps).toMatchObject({ portal: false, partners: 'partner' });
    const leads = await request(app).get('/api/v1/pp/leads').set('Authorization', `Bearer ${partner.body.data.accessToken}`);
    expect(leads.status).toBe(200);

    const founder = await request(app).post('/api/v1/auth/login').send({ email: 'saswat@hq.io', password: PASSWORD });
    expect(founder.status).toBe(200);
    expect(founder.body.data.user.apps).toMatchObject({ founders: 'saswat', foundersRole: 'cofounder' });

    const ceo = await request(app).post('/api/v1/auth/login').send({ email: 'ceo@old.io', password: PASSWORD });
    expect(ceo.status).toBe(200);
    expect(ceo.body.data.user.apps).toMatchObject({ portal: true, partners: 'admin', founders: 'rahul', foundersRole: 'founder' });
  });
});

// Real Postgres (knex reader): only when TEST_LEGACY_PG_URL points at a server where a database may be created.
const PG_URL = process.env.TEST_LEGACY_PG_URL;
(PG_URL ? describe : describe.skip)('knex reader against a throwaway Postgres database', () => {
  let admin;
  let pgDb;
  let pgUrl;
  const dbName = `marioxone_test_${randomBytes(5).toString('hex')}`;

  beforeAll(async () => {
    const { default: knexFactory } = await import('knex');
    admin = knexFactory({ client: 'pg', connection: PG_URL, pool: { min: 0, max: 1 } });
    await admin.raw(`create database ${dbName}`);
    const u = new URL(PG_URL);
    u.pathname = `/${dbName}`;
    pgUrl = u.toString();
    pgDb = knexFactory({ client: 'pg', connection: pgUrl, pool: { min: 0, max: 2 } });
    await pgDb.migrate.latest({ directory: path.join(HERE, '../src/db/migrations'), loadExtensions: ['.js'] });
    await pgDb('roles').insert({ id: 'r-pg', name: 'PG Role', perms: { leads: { v: true } } }).onConflict('id').ignore();
    await pgDb('members').insert({ id: 'mpg', name: 'Pg Member', team: 'Web', cost_per_hour: 399.99 });
    await pgDb('users').insert({ id: 'u-pg', name: 'Pg User', email: 'Pg.User@Old.io', role_id: 'r-pg', status: 'Active', client_of: ['PR-901'], shift_hours: 7.25, join_date: '2026-02-03' });
    await pgDb('sales_owners').insert({ id: 'spg', name: 'Pg Owner' });
    await pgDb('lead_stages').insert({ name: 'New', position: 0, is_core: true });
    await pgDb('leads').insert({ id: 'MX-1901', company: 'PgCo', contact: 'X', owner_id: 'spg', services: ['Web Development', 'AI / ML'], value: 12345.67 });
    await pgDb('quotes').insert({ id: 'Q-1901-1', lead_id: 'MX-1901', items: JSON.stringify([{ d: 'Build', q: 2, r: 10 }]), net: 20, total: 23.6 });
    await pgDb.raw("select nextval('lead_code_seq') from generate_series(1, 950)"); // sequence at 1950
    await pgDb('refresh_tokens').insert({ user_id: 'u-pg', token_hash: 'h', expires_at: new Date() });
  });

  afterAll(async () => {
    await pgDb?.destroy();
    await admin?.raw(`drop database if exists ${dbName} with (force)`).catch(() => {});
    await admin?.destroy();
  });

  test('reads real Postgres types and migrates them (read-only session)', async () => {
    const reader = knexPortalReader(pgUrl);
    try {
      const report = await runMigration({ only: ['portal'], dryRun: false, portalReader: reader });
      expect(problemsOf(report, 'portal.users', 'error')).toEqual([]);
      expect(rowOf(report, 'portal.refresh_tokens', '(not migrated)')).toMatchObject({ read: 1, skipped: 1 });
    } finally {
      await reader.close();
    }
    expect(await M.User.findOne({ id: 'u-pg' }).rows()).toMatchObject({ email: 'Pg.User@Old.io', client_of: ['PR-901'], shift_hours: 7.25, join_date: '2026-02-03', role_id: 'r-pg' });
    expect(await M.Member.findOne({ id: 'mpg' }).rows()).toMatchObject({ cost_per_hour: 399.99 });
    expect(await M.Lead.findOne({ id: 'MX-1901' }).rows()).toMatchObject({ value: 12345.67, services: ['Web Development', 'AI / ML'] });
    expect((await M.Quote.findOne({ id: 'Q-1901-1' }).rows()).items).toEqual([{ d: 'Build', q: 2, r: 10 }]);
    expect((await M.Role.findOne({ id: 'r-pg' }).rows()).perms.leads.v).toBe(true);
    expect((await mongoose.connection.collection('counters').findOne({ _id: 'lead_code_seq' })).value).toBe(1950);
  });
});
