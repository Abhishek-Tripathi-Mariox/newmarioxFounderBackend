/**
 * Shared test harness. Each test file calls `await resetDb()` in beforeAll (or beforeEach) to get a
 * clean test database with base data + a small fixture, then uses `as(email)` for an authenticated
 * supertest agent, and `closeDb()` in afterAll.
 *
 * Database: a throwaway `marioxone_test_<random>` on TEST_MONGODB_URI, one per jest run (named by
 * tests/globalSetup.js; dropped by closeDb() and again by tests/globalTeardown.js). Tests never
 * connect to any other database.
 *
 * Fixture (password for everyone: "secret123"):
 *   ceo@test.io      Super Admin
 *   admin@test.io    Admin
 *   sm@test.io       Sales Manager      (sales owner 'ak')
 *   se@test.io       Sales Executive    (sales owner 'ps')
 *   pm@test.io       Project Manager    (member 'mj', team PMO)
 *   dev@test.io      Team Member        (member 'vg', team Mobile)
 *   dev2@test.io     Team Member        (member 'si', team Mobile)
 *   qa@test.io       QA Engineer        (member 'dn', team QA)
 *   client@test.io   Client             (client of PR-101)
 *   off@test.io      Team Member, Deactivated
 * Members: mj (PMO), vg + si (Mobile), dn (QA), km (Backend). Sales owners: ak, ps.
 * Project PR-101 "Alpha App" (Running, PM mj, team mj/vg/si/dn) with milestones PR-101-M1..M2;
 * project PR-102 "Beta Web" (Running, PM mj, team mj/km). Leads: MX-1001 (owner ak), MX-1002 (owner ps).
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import request from 'supertest';
import { connectMongo, disconnectMongo, ensureIndexes } from '../src/db/mongo.js';
import { resetSequences, setSeq } from '../src/db/counters.js';
import * as models from '../src/db/models/index.js';
import { Lead, Member, Milestone, Project, ProjectMember, SalesOwner, User } from '../src/db/models/index.js';
import { createApp } from '../src/app.js';
import { seedBase } from '../src/db/seed/base.js';

export const app = createApp();
export const PASSWORD = 'secret123';

export const TEST_DB_PREFIX = 'marioxone_test_';
const TEST_DB = process.env.MARIOXONE_TEST_DB || `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;

/** Connect to this run's throwaway test database (idempotent) and build its indexes. */
export async function connectTestDb() {
  if (!TEST_DB.startsWith(TEST_DB_PREFIX)) throw new Error(`Refusing to use database "${TEST_DB}" for tests`);
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === TEST_DB) return;
  await connectMongo({ dbName: TEST_DB });
  await ensureIndexes();
}

/** Empty every collection (indexes stay) and restart every sequence. */
export async function emptyTestDb() {
  await connectTestDb();
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  await resetSequences();
}

export async function resetDb() {
  await emptyTestDb();
  await seedBase();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local (APP_TZ) day
  await Member.insertMany([
    { id: 'mj', name: 'Meera Joshi', role_title: 'Project Manager', team: 'PMO', hue: 300 },
    { id: 'vg', name: 'Vikas Gupta', role_title: 'Android Developer', team: 'Mobile', hue: 150 },
    { id: 'si', name: 'Sneha Iyer', role_title: 'iOS Developer', team: 'Mobile', hue: 190 },
    { id: 'dn', name: 'Divya Nair', role_title: 'QA Engineer', team: 'QA', hue: 30 },
    { id: 'km', name: 'Karan Malhotra', role_title: 'Backend Developer', team: 'Backend', hue: 70 },
  ]);
  await SalesOwner.insertMany([{ id: 'ak', name: 'Aman Kapoor', hue: 265 }, { id: 'ps', name: 'Priya Sharma', hue: 340 }]);
  const u = (id, name, email, role_id, extra = {}) => ({ id, name, email, role_id, status: 'Active', password_hash: hash, ...extra });
  await User.insertMany([
    u('u-ceo', 'CEO', 'ceo@test.io', 'r-super', { dept: 'Management' }),
    u('u-admin', 'Ada Admin', 'admin@test.io', 'r-admin', { dept: 'HR' }),
    u('u-ak', 'Aman Kapoor', 'sm@test.io', 'r-sm', { dept: 'Sales', owner_id: 'ak' }),
    u('u-ps', 'Priya Sharma', 'se@test.io', 'r-se', { dept: 'Sales', owner_id: 'ps' }),
    u('u-mj', 'Meera Joshi', 'pm@test.io', 'r-pm', { dept: 'PMO', member_id: 'mj' }),
    u('u-vg', 'Vikas Gupta', 'dev@test.io', 'r-tm', { dept: 'Mobile', member_id: 'vg' }),
    u('u-si', 'Sneha Iyer', 'dev2@test.io', 'r-tm', { dept: 'Mobile', member_id: 'si' }),
    u('u-dn', 'Divya Nair', 'qa@test.io', 'r-qa', { dept: 'QA', member_id: 'dn' }),
    u('u-cl1', 'Alpha Client', 'client@test.io', 'r-client', { client_of: ['PR-101'] }),
    u('u-off', 'Old Dev', 'off@test.io', 'r-tm', { status: 'Deactivated' }),
  ]);
  await Project.insertMany([
    { id: 'PR-101', name: 'Alpha App', client: 'Alpha Retail', services: ['Mobile App'], status: 'Running', pm_member_id: 'mj', start_date: '2026-09-01', due_date: '2026-12-31', value: 1000000, priority: 'High' },
    { id: 'PR-102', name: 'Beta Web', client: 'Beta Health', services: ['Web Development'], status: 'Running', pm_member_id: 'mj', start_date: '2026-10-01', due_date: '2027-01-31', value: 500000 },
  ]);
  await ProjectMember.insertMany([
    { project_id: 'PR-101', member_id: 'mj', alloc_hours: 40, position: 0 }, { project_id: 'PR-101', member_id: 'vg', alloc_hours: 120, position: 1 },
    { project_id: 'PR-101', member_id: 'si', alloc_hours: 120, position: 2 }, { project_id: 'PR-101', member_id: 'dn', alloc_hours: 60, position: 3 },
    { project_id: 'PR-102', member_id: 'mj', alloc_hours: 20, position: 0 }, { project_id: 'PR-102', member_id: 'km', alloc_hours: 100, position: 1 },
  ]);
  await Milestone.insertMany([
    { id: 'PR-101-M1', project_id: 'PR-101', n: 1, name: 'Discovery & UI/UX', alloc_hours: 60, due_date: '2026-10-01', status: 'Done' },
    { id: 'PR-101-M2', project_id: 'PR-101', n: 2, name: 'Development · Phase 1', alloc_hours: 200, due_date: '2026-12-01', status: 'In progress' },
    { id: 'PR-102-M1', project_id: 'PR-102', n: 1, name: 'Discovery & UI/UX', alloc_hours: 40, due_date: '2026-11-15', status: 'In progress' },
  ]);
  await Lead.insertMany([
    { id: 'MX-1001', company: 'Zenvy Retail', contact: 'Ankit Mehta', email: 'ankit@zenvy.com', phone: '+91 98765 43210', services: ['Mobile App'], source: 'Website', owner_id: 'ak', first_owner_id: 'ak', status: 'New', value: 800000 },
    { id: 'MX-1002', company: 'Kaveri Foods', contact: 'Riya Gupta', email: 'riya@kaveri.com', phone: '+91 91234 56789', services: ['Web Development'], source: 'Referral', owner_id: 'ps', first_owner_id: 'ps', status: 'Qualified', value: 350000 },
  ]);
  // The fixture uses MX-1001/1002 and PR-101/102: new codes continue after them.
  await setSeq('lead_code_seq', 1002);
  await setSeq('project_code_seq', 102);
  return { today };
}

const tokens = {};
/** Log in (cached per email) and return an authenticated supertest wrapper: as('pm@test.io').get('/api/v1/projects') */
export async function tokenFor(email) {
  if (!tokens[email]) {
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    tokens[email] = res.body.data.accessToken;
  }
  return tokens[email];
}
export const clearTokens = () => { for (const k of Object.keys(tokens)) delete tokens[k]; };

export async function as(email) {
  const t = await tokenFor(email);
  const wrap = (m) => (url) => request(app)[m](url).set('Authorization', `Bearer ${t}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') };
}

/** Drop this run's test database and disconnect. */
export async function closeDb() {
  if (mongoose.connection.readyState === 1 && mongoose.connection.name.startsWith(TEST_DB_PREFIX)) await mongoose.connection.dropDatabase();
  await disconnectMongo();
}
