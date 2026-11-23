/**
 * Any role can get any permission (src/core/permissions.js): the Mariox Partners admin console is
 * permissioned per section (pp_*), the legacy single `pp` switch keeps working, actions that don't
 * exist stay off, "Attendance & reports" Edit acts on people's day, and a project's PM can hold any
 * role that edits projects.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { PpUser, Role, User } from '../src/db/models/index.js';
import { normalisePerms } from '../src/core/permissions.js';
import { app, as, clearTokens, closeDb, PASSWORD, resetDb, tokenFor } from './helpers.js';
import { addPartner, istDay, PP, PP_PASSWORD } from './pp-helpers.js';

const API = '/api/v1';
const today = istDay(0);

/** Portal login with a cookie-keeping agent (the partner API rides on the mx_refresh cookie). */
async function agentFor(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(`${API}/auth/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.data.user };
}

/** A role stored as-is (perms not normalised), and an active user holding it. */
async function roleWithUser({ roleId, perms, userId, email }) {
  await Role.insertMany([{ id: roleId, name: `Role ${roleId}`, perms }]);
  await User.insertMany([{ id: userId, name: `User ${userId}`, email, role_id: roleId, status: 'Active', password_hash: await bcrypt.hash(PASSWORD, 4) }]);
}

const cell = (v, c = 0, e = 0, d = 0, scope = 'all') => ({ v: !!v, c: !!c, e: !!e, d: !!d, scope });

let rohit; // partner profile id
let acqLead; // an acquisition lead id
let ppLead; // a partner lead id

beforeAll(async () => {
  await resetDb();
  clearTokens();
  rohit = await addPartner({ userId: 'u-rohit', name: 'Rohit Sharma', email: 'rohit@pp.io', partnerCode: 'MX-P-243-1', commissionRate: 0.5 });
  // Fixtures made by the Super Admin.
  const { agent: ceo } = await agentFor('ceo@test.io');
  acqLead = (await ceo.post(`${PP}/admin/acquisition`).send({ name: 'Ananya Mehta', company: 'BrightPath', contactedAt: today, today, source: 'LinkedIn', channel: 'WhatsApp', owner: 'Aman' })).body.lead._id;
  ppLead = (await ceo.post(`${PP}/leads`).send({ company: 'Zenvy Retail', project: 'Shop app', value: '800000', contact: 'Ankit Mehta', owner: rohit })).body.lead._id;
  expect(acqLead).toBeTruthy();
  expect(ppLead).toBeTruthy();

  // Acquisition (view + edit) and partner Leads (view) only — no portal modules.
  await roleWithUser({ roleId: 'r-acq', perms: { pp_acq: cell(1, 0, 1, 0), pp_leads: cell(1) }, userId: 'u-acq', email: 'acq@test.io' });
  // Old data: the single legacy `pp` switch.
  await roleWithUser({ roleId: 'r-oldview', perms: { leads: cell(1), pp: { v: true, c: false, e: false, d: false, scope: 'all' } }, userId: 'u-oldview', email: 'oldview@test.io' });
  await roleWithUser({ roleId: 'r-oldedit', perms: { pp: { v: true, c: false, e: true, d: false, scope: 'all' } }, userId: 'u-oldedit', email: 'oldedit@test.io' });
});
afterAll(closeDb);

describe('permission model', () => {
  test('normalisePerms: every module present; legacy pp → every partner section (Edit = C/E/D)', () => {
    const p = normalisePerms({ leads: cell(1, 1), pp: { v: true, e: true } });
    expect(p.leads).toEqual(cell(1, 1));
    expect(p.pp).toBeUndefined();
    expect(p.pp_acq).toEqual(cell(1, 1, 1, 1));
    expect(p.pp_overview).toEqual(cell(1)); // view-only section
    expect(p.pp_requests).toEqual(cell(1, 0, 1, 1)); // no Create
    expect(p.pp_settings).toEqual(cell(1, 0, 1, 0));
    expect(normalisePerms({ pp: { v: true, e: true }, pp_kit: cell(1) }).pp_acq).toEqual(cell(0)); // new keys win
    expect(normalisePerms(null).att).toEqual(cell(0));
  });

  test('GET /roles shows legacy roles expanded; saving writes the new keys and drops pp', async () => {
    const ceo = await as('ceo@test.io');
    const roles = (await ceo.get(`${API}/roles`)).body.data;
    const old = roles.find((r) => r.id === 'r-oldedit');
    expect(old.perms.pp).toBeUndefined();
    expect(old.perms.pp_partners).toEqual(cell(1, 1, 1, 1));
    expect(roles.find((r) => r.id === 'r-oldview').perms.pp_kit).toEqual(cell(1));
    expect(roles.find((r) => r.id === 'r-super').perms.pp_settings).toEqual(cell(1, 0, 1, 0));
    expect(roles.find((r) => r.id === 'r-admin').perms.pp_acq).toEqual(cell(0)); // Admin: no partner console by default

    await ceo.patch(`${API}/roles/r-oldview`).send({ perms: { leads: { e: true } } });
    const stored = await Role.findOne({ id: 'r-oldview' }).rows();
    expect(stored.perms.pp).toBeUndefined();
    expect(stored.perms.pp_partners).toEqual(cell(1));
    expect(stored.perms.leads).toEqual(cell(1, 0, 1));
  });

  test('actions a module does not have stay off; partner sections have no scope; att Edit is assignable', async () => {
    const ceo = await as('ceo@test.io');
    const id = (await ceo.post(`${API}/roles`).send({ name: 'Perm editor test' })).body.data.id;
    const patch = async (perms) => (await ceo.patch(`${API}/roles/${id}`).send({ perms })).body.data.perms;
    let p = await patch({ pp_overview: { c: true, e: true, d: true } });
    expect(p.pp_overview).toEqual(cell(1)); // turning one on turns View on, the rest don't exist
    p = await patch({ pp_requests: { c: true, e: true }, pp_settings: { d: true, e: true } });
    expect(p.pp_requests).toEqual(cell(1, 0, 1, 0));
    expect(p.pp_settings).toEqual(cell(1, 0, 1, 0));
    p = await patch({ pp_acq: { v: true, scope: 'own' } });
    expect(p.pp_acq.scope).toBe('all');
    p = await patch({ att: { e: true, c: true, d: true, scope: 'team' } });
    expect(p.att).toEqual(cell(1, 0, 1, 0, 'team'));
    p = await patch({ dash: { c: true }, projects: { d: true }, ts: { d: true }, team: { e: true } });
    expect([p.dash.c, p.projects.d, p.ts.d, p.team.e]).toEqual([false, false, false, false]);
    expect((await ceo.patch(`${API}/roles/${id}`).send({ perms: { pp_nope: { v: true } } })).status).toBe(422);
  });
});

describe('partner admin console, per section', () => {
  let acq;
  beforeAll(async () => {
    const r = await agentFor('acq@test.io');
    acq = r.agent;
    expect(r.user.apps.partners).toBe('admin'); // any partner section viewable
    expect(r.user.home).toBe('/partners/admin'); // nothing to open in the team portal
  });

  test('/pp/me returns the section permissions', async () => {
    const me = (await acq.get(`${PP}/me`)).body.user;
    expect(me.role).toBe('admin');
    expect(me.perms.pp_acq).toEqual({ v: true, c: false, e: true, d: false });
    expect(me.perms.pp_leads).toEqual({ v: true, c: false, e: false, d: false });
    expect(me.perms.pp_partners).toEqual({ v: false, c: false, e: false, d: false });
  });

  test('Acquisition: view + edit allowed; create / import / samples / delete refused', async () => {
    expect((await acq.get(`${PP}/admin/acquisition`)).status).toBe(200);
    const edited = await acq.patch(`${PP}/admin/acquisition/${acqLead}`).send({ action: 'notes', notes: 'Called back' });
    expect(edited.status).toBe(200);
    expect(edited.body.lead.notes).toBe('Called back');
    expect((await acq.put(`${PP}/admin/acquisition/settings`).send({ lists: { team: ['Aman', 'Zoya'], sources: ['LinkedIn'], channels: ['WhatsApp'], reasons: ['Busy'], services: ['Apps'], prep: ['Deck'] } })).status).not.toBe(403);
    const add = await acq.post(`${PP}/admin/acquisition`).send({ name: 'X Y', contactedAt: today, today, source: 'LinkedIn', channel: 'WhatsApp', owner: 'Aman' });
    expect(add.status).toBe(403);
    expect(add.body).toEqual({ error: 'Your role can’t add partner acquisition in Mariox Partners' });
    expect((await acq.post(`${PP}/admin/acquisition/import`).send({ rows: [], today })).status).toBe(403);
    expect((await acq.post(`${PP}/admin/acquisition/sample`).send({ action: 'load', today })).status).toBe(403);
    expect((await acq.post(`${PP}/admin/acquisition/sample`).send({ action: 'clear', today })).status).toBe(403);
    expect((await acq.delete(`${PP}/admin/acquisition/${acqLead}`)).status).toBe(403);
  });

  test('Leads: view only', async () => {
    expect((await acq.get(`${PP}/leads`)).body.leads.map((l) => l._id)).toContain(ppLead);
    expect((await acq.get(`${PP}/leads/${ppLead}`)).status).toBe(200);
    expect((await acq.patch(`${PP}/leads/${ppLead}`).send({ project: 'New name' })).status).toBe(403);
    expect((await acq.post(`${PP}/leads`).send({ company: 'Nova', owner: rohit })).status).toBe(403);
    expect((await acq.delete(`${PP}/leads/${ppLead}`)).status).toBe(403);
  });

  test('Partners list: only the partner picker (names, no contact details); the rest refused', async () => {
    const list = await acq.get(`${PP}/admin/users`);
    expect(list.status).toBe(200);
    expect(list.body.users.every((u) => u.role === 'partner')).toBe(true);
    const r = list.body.users.find((u) => u.id === rohit);
    expect(r).toMatchObject({ name: 'Rohit Sharma', partnerCode: 'MX-P-243-1', commissionRate: 0.5 });
    expect(r.email).toBeUndefined();
    expect((await acq.get(`${PP}/admin/users/${rohit}`)).status).toBe(403);
    expect((await acq.patch(`${PP}/admin/users/${rohit}`).send({ commissionRate: 0.2 })).status).toBe(403);
    expect((await acq.post(`${PP}/admin/users`).send({ name: 'New Partner', email: 'np@pp.io', password: 'Partner@123' })).status).toBe(403);
    expect((await acq.delete(`${PP}/admin/users/${rohit}`)).status).toBe(403);
  });

  test('sections the role lacks: 403 (settings stay readable: every page uses the pipeline)', async () => {
    for (const path of ['/projects', '/requests/scope', '/requests/ticket', '/resources', '/availability?office=Noida&date=2026-12-01']) {
      const res = await acq.get(`${PP}${path}`);
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect((await acq.post(`${PP}/projects`).send({})).status).toBe(403);
    expect((await acq.post(`${PP}/resources`).send({})).status).toBe(403);
    expect((await acq.get(`${PP}/settings`)).status).toBe(200);
    const put = await acq.put(`${PP}/settings`).send({ announcement: 'Hi' });
    expect(put.status).toBe(403);
    expect(put.body).toEqual({ error: 'Your role can’t change settings in Mariox Partners' });
    // Uploading (sales-kit files) needs Sales kit Create / Edit.
    expect((await acq.post(`${PP}/uploads`).attach('files', Buffer.from('x'), 'a.pdf')).status).toBe(403);
  });

  test('staff without any partner section: no access; partners unaffected', async () => {
    const { agent: pm, user } = await agentFor('pm@test.io');
    expect(user.apps.partners).toBeNull();
    expect((await pm.get(`${PP}/me`)).status).toBe(403);
    const { agent: partner } = await agentFor('rohit@pp.io', PP_PASSWORD);
    expect((await partner.get(`${PP}/leads`)).body.leads.map((l) => l._id)).toContain(ppLead);
    expect((await partner.get(`${PP}/projects`)).status).toBe(200);
    expect((await partner.get(`${PP}/requests/scope`)).status).toBe(200);
    expect((await partner.get(`${PP}/resources`)).status).toBe(200);
    expect((await partner.get(`${PP}/admin/acquisition`)).body).toEqual({ error: 'Admins only' });
    expect((await partner.get(`${PP}/me`)).body.user.perms).toEqual({});
  });

  test('Super Admin keeps everything', async () => {
    const { agent: ceo } = await agentFor('ceo@test.io');
    const me = (await ceo.get(`${PP}/me`)).body.user;
    expect(me.perms.pp_partners).toEqual({ v: true, c: true, e: true, d: true });
    expect(me.perms.pp_requests).toEqual({ v: true, c: false, e: true, d: true });
    expect((await ceo.get(`${PP}/admin/users/${rohit}`)).body.user.email).toBe('rohit@pp.io');
  });
});

describe('legacy pp perms keep working without a migration', () => {
  test('pp View: every section readable, nothing changeable', async () => {
    const { agent, user } = await agentFor('oldview@test.io');
    expect(user.apps.partners).toBe('admin');
    expect((await agent.get(`${PP}/admin/users`)).body.users.some((u) => u.email === 'rohit@pp.io')).toBe(true);
    for (const path of ['/admin/acquisition', '/leads', '/projects', '/requests/booking', '/resources']) {
      expect([path, (await agent.get(`${PP}${path}`)).status]).toEqual([path, 200]);
    }
    expect((await agent.patch(`${PP}/leads/${ppLead}`).send({ project: 'Nope' })).status).toBe(403);
    expect((await agent.put(`${PP}/settings`).send({ announcement: 'Hi' })).status).toBe(403);
  });

  test('pp Edit: create / edit / delete everywhere, as before', async () => {
    const { agent } = await agentFor('oldedit@test.io');
    const p = await PpUser.findById(rohit).lean();
    expect((await agent.patch(`${PP}/admin/users/${rohit}`).send({ commissionRate: p.commissionRate })).status).toBe(200);
    const made = await agent.post(`${PP}/admin/acquisition`).send({ name: 'Legacy Lead', contactedAt: today, today, source: 'LinkedIn', channel: 'WhatsApp', owner: 'Aman' });
    expect(made.status).toBe(201);
    expect((await agent.delete(`${PP}/admin/acquisition/${made.body.lead._id}`)).status).toBe(200);
    const kit = await agent.post(`${PP}/resources`).send({ type: 'Deck', title: 'Company deck', url: 'https://example.com/deck' });
    expect(kit.status).toBe(201);
    expect((await agent.delete(`${PP}/resources/${kit.body.item._id}`)).status).toBe(200);
  });
});

describe('Attendance & reports: Edit acts on people in scope', () => {
  beforeAll(async () => {
    await User.updateOne({ id: 'u-vg' }, { reports_to: 'u-mj' });
    clearTokens();
  });

  test('View only (seed PM, scope Team): cannot act on anyone', async () => {
    const pm = await as('pm@test.io');
    expect((await pm.post(`${API}/live/vg/check-in`)).status).toBe(403);
  });

  test('Edit + Team: their reportees yes, others no; previewing never', async () => {
    const ceo = await as('ceo@test.io');
    await ceo.patch(`${API}/roles/r-pm`).send({ perms: { att: { e: true } } });
    clearTokens();
    const pm = await as('pm@test.io');
    const ok = await pm.post(`${API}/live/vg/check-in`);
    expect(ok.status).toBe(200);
    const out = await pm.post(`${API}/live/si/check-in`);
    expect(out.status).toBe(403);
    expect(out.body.error.message).toBe('This person is outside your attendance scope');
    expect((await pm.post(`${API}/live/vg/check-out`)).status).toBe(200);
    // Their live state now covers the team (to act from Attendance).
    const st = (await pm.get(`${API}/live/state`)).body.data;
    expect(Object.keys(st.att).sort()).toEqual(['vg']);
    const pv = await request(app).post(`${API}/live/vg/check-in`).set('Authorization', `Bearer ${await tokenFor('ceo@test.io')}`).set('X-View-As', 'u-mj');
    expect(pv.status).toBe(403);
    expect(pv.body.error.message).toBe('Exit preview to change attendance');
  });

  test('CSV export: att View, limited to the scope', async () => {
    const pm = await as('pm@test.io');
    const res = await pm.get(`${API}/attendance/export.csv?range=today`);
    expect(res.status).toBe(200);
    const names = new Set(res.text.trim().split('\n').slice(1).map((l) => l.split(',')[1]));
    expect([...names].sort()).toEqual(['Meera Joshi', 'Vikas Gupta']);
    expect((await (await as('dev@test.io')).get(`${API}/attendance/export.csv?range=today`)).status).toBe(403); // no att View
    const ceoCsv = await (await as('ceo@test.io')).get(`${API}/attendance/export.csv?range=today`);
    expect(ceoCsv.text).toContain('Sneha Iyer');
  });
});

describe('the project PM can hold any role that edits projects', () => {
  test('a copy of Project Manager still runs the projects they manage', async () => {
    const ceo = await as('ceo@test.io');
    const copy = (await ceo.post(`${API}/roles/r-pm/duplicate`)).body.data;
    await User.updateOne({ id: 'u-mj' }, { role_id: copy.id });
    clearTokens();
    const pm = await as('pm@test.io');
    const cr = await pm.post(`${API}/change-requests`).send({
      projectId: 'PR-101', title: 'Wishlist feature', description: 'Save items for later', requestedBy: 'Client', requestedByName: '',
      hours: 16, extraDays: 5, priority: 'High', target: 'new', team: [], tasks: [{ title: 'Wishlist API', assigneeId: 'km', hours: 10 }],
    });
    expect(cr.status).toBe(201);
    // Without projects Edit they are not treated as the PM.
    await ceo.patch(`${API}/roles/${copy.id}`).send({ perms: { projects: { e: false } } });
    clearTokens();
    const again = await (await as('pm@test.io')).post(`${API}/change-requests`).send({ projectId: 'PR-101', title: 'Another change', description: 'x', requestedBy: 'Client', requestedByName: '', hours: 4, extraDays: 1, priority: 'Low', target: 'new', team: [], tasks: [] });
    expect(again.status).toBe(403);
  });
});
