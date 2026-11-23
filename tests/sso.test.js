/**
 * One login for Mariox One (docs/SSO.md): one account and one session (mx_refresh, path /api/v1)
 * open the internal portal, Mariox Partners (/pp) and Founders HQ (/hq) according to the person's rights.
 */
import request from 'supertest';
import { PpUser, RefreshToken, User } from '../src/db/models/index.js';
import { app, as, clearTokens, closeDb, PASSWORD, resetDb } from './helpers.js';
import { addPartner, PP_PASSWORD } from './pp-helpers.js';

const API = '/api/v1';
const PP = `${API}/pp`;
const HQ = `${API}/hq`;

const cookieOf = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('mx_refresh='));

/** Portal login with a cookie-keeping agent → { agent, res }. */
async function signIn(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(`${API}/auth/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, res };
}

beforeEach(async () => {
  await resetDb();
  clearTokens();
  await User.updateOne({ id: 'u-ceo' }, { hq_seat: 'rahul' });
  await addPartner({ userId: 'u-rohit', name: 'Rohit Sharma', email: 'rohit@pp.io', partnerCode: 'MX-P-243-1' });
});
afterAll(closeDb);

describe('the session', () => {
  test('the refresh cookie covers the whole API (/api/v1), so /pp and /hq receive it', async () => {
    const { res } = await signIn('ceo@test.io');
    expect(cookieOf(res)).toMatch(/Path=\/api\/v1(;|$)/);
  });

  test('login, refresh and /auth/me carry `apps` and `home`', async () => {
    const { agent, res } = await signIn('ceo@test.io');
    const apps = { portal: true, partners: 'admin', founders: 'rahul' };
    expect(res.body.data.user).toMatchObject({ apps, home: '/founders' });
    const refreshed = await agent.post(`${API}/auth/refresh`);
    expect(refreshed.body.data.user).toMatchObject({ apps, home: '/founders' });
    const me = await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${refreshed.body.data.accessToken}`);
    expect(me.body.data).toMatchObject({ apps, home: '/founders' });

    expect((await signIn('pm@test.io')).res.body.data.user).toMatchObject({ apps: { portal: true, partners: null, founders: null }, home: '/follow-ups' }); // first module the role can view
    expect((await signIn('admin@test.io')).res.body.data.user).toMatchObject({ apps: { portal: true, partners: null, founders: null }, home: '/dashboard' });
    expect((await signIn('rohit@pp.io', PP_PASSWORD)).res.body.data.user)
      .toMatchObject({ apps: { portal: false, partners: 'partner', founders: null }, home: '/partners/dashboard' });
  });

  test('logout revokes access to Partners and Founders HQ too', async () => {
    const { agent, res } = await signIn('ceo@test.io');
    const token = decodeURIComponent(cookieOf(res).split(';')[0].split('=')[1]);
    expect((await agent.get(`${PP}/me`)).status).toBe(200);
    expect((await agent.get(`${HQ}/auth/me`)).status).toBe(200);

    // Only the cookie: no Bearer, no body.
    const out = await agent.post(`${API}/auth/logout`);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/mx_refresh=;.*Path=\/api\/v1(;|$)/);
    expect((await agent.get(`${PP}/me`)).status).toBe(401);
    expect((await agent.get(`${HQ}/auth/me`)).status).toBe(401);
    // Even a copy of the old cookie is dead: the session was revoked, not just forgotten.
    const replayPp = await request(app).get(`${PP}/me`).set('Cookie', `mx_refresh=${token}`);
    expect(replayPp.status).toBe(401);
    expect(replayPp.body).toEqual({ error: 'Your session ended. Please sign in again.' });
    expect((await request(app).get(`${HQ}/auth/me`).set('Cookie', `mx_refresh=${token}`)).status).toBe(401);
  });
});

describe('what each area accepts', () => {
  test('one account opens all three areas according to its rights', async () => {
    // Super Admin with the Founder seat: everything.
    const { agent: ceo, res } = await signIn('ceo@test.io');
    expect((await request(app).get(`${API}/users`).set('Authorization', `Bearer ${res.body.data.accessToken}`)).status).toBe(200);
    const ppMe = await ceo.get(`${PP}/me`);
    expect(ppMe.status).toBe(200);
    expect(ppMe.body.user).toMatchObject({ role: 'admin', email: 'ceo@test.io', apps: { portal: true, partners: 'admin', founders: 'rahul' } }); // admin profile created and linked on first use
    expect((await User.findOne({ id: 'u-ceo' }).rows()).pp_user_id).toBe(ppMe.body.user.id);
    expect((await ceo.get(`${PP}/admin/users`)).status).toBe(200);
    expect((await ceo.get(`${HQ}/auth/me`)).body.data.user).toMatchObject({ seat: 'rahul', email: 'ceo@test.io', name: 'CEO' });

    // Staff without the pp permission or a seat: the portal only.
    const { agent: pm } = await signIn('pm@test.io');
    const noPp = await pm.get(`${PP}/me`);
    expect(noPp.status).toBe(403);
    expect(noPp.body).toEqual({ error: 'Your role has no access to Mariox Partners' });
    expect((await pm.get(`${HQ}/auth/me`)).status).toBe(403);
    expect((await (await as('pm@test.io')).get(`${API}/projects`)).status).toBe(200);

    // A partner: the partner side only.
    const { agent: partner } = await signIn('rohit@pp.io', PP_PASSWORD);
    expect((await partner.get(`${PP}/me`)).body.user.partnerCode).toBe('MX-P-243-1');
    expect((await partner.get(`${PP}/admin/users`)).body).toEqual({ error: 'Admins only' });
    expect((await partner.get(`${HQ}/auth/me`)).status).toBe(403);
  });

  test('partners cannot use the internal API (403), except /auth', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ email: 'rohit@pp.io', password: PP_PASSWORD });
    const bearer = { Authorization: `Bearer ${login.body.data.accessToken}` };
    for (const path of ['/projects', '/leads', '/users', '/members', '/workday/me', '/team-tasks', '/live']) {
      const res = await request(app).get(`${API}${path}`).set(bearer);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.error.message).toBe('Partner accounts can only open Mariox Partners');
    }
    expect((await request(app).get(`${API}/auth/me`).set(bearer)).status).toBe(200);
    // A Super Admin previewing as a partner gets no internal data either.
    expect((await (await as('ceo@test.io')).get(`${API}/projects`).set('X-View-As', 'u-rohit')).status).toBe(403);
  });

  test('staff without a seat get 403 on /hq; a Super Admin grants and removes the seat in Users & roles', async () => {
    const { agent: admin } = await signIn('admin@test.io');
    const denied = await admin.get(`${HQ}/workspace`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe('Founders HQ is only open to founders and co-founders.');

    // Only a Super Admin can set the seat; one person per seat; never on partners / clients.
    const asAdmin = await as('admin@test.io');
    expect((await asAdmin.patch(`${API}/users/u-admin`).send({ hq_seat: 'saswat' })).status).toBe(403);
    const ceo = await as('ceo@test.io');
    expect((await ceo.patch(`${API}/users/u-admin`).send({ hq_seat: 'rahul' })).body.error.message).toBe('The Founder seat is already taken by CEO.');
    expect((await ceo.patch(`${API}/users/u-cl1`).send({ hq_seat: 'saswat' })).status).toBe(422);
    const granted = await ceo.patch(`${API}/users/u-admin`).send({ hq_seat: 'saswat' });
    expect(granted.status).toBe(200);
    expect(granted.body.data.hq_seat).toBe('saswat');
    expect((await admin.get(`${HQ}/auth/me`)).body.data.user).toMatchObject({ seat: 'saswat', seatLabel: 'Co-founder' });

    expect((await ceo.patch(`${API}/users/u-admin`).send({ hq_seat: null })).body.data.hq_seat).toBeNull();
    expect((await admin.get(`${HQ}/auth/me`)).status).toBe(403);
  });

  test('HQ Accounts: create = a new Super Admin with the seat; delete = the seat, not the person', async () => {
    const { agent: ceo } = await signIn('ceo@test.io');
    const created = await ceo.post(`${HQ}/users`).send({ name: 'Saswat', email: 'saswat@test.io', password: 'a-good-password' });
    expect(created.status).toBe(201);
    // A new member gets a person id of their own (from their user id) and is a Co-founder by default.
    const personId = created.body.data.seat;
    expect(personId).toBe(created.body.data.userId);
    expect(created.body.data).toMatchObject({ role: 'cofounder', seatLabel: 'Co-founder', email: 'saswat@test.io' });
    const { agent: saswat, res } = await signIn('saswat@test.io', 'a-good-password');
    expect(res.body.data.user).toMatchObject({ isSuper: true, apps: { founders: personId, foundersRole: 'cofounder' } });
    expect((await ceo.get(`${HQ}/users`)).body.data.map((u) => u.email)).toEqual(['ceo@test.io', 'saswat@test.io']);

    expect((await ceo.delete(`${HQ}/users/${created.body.data.id}`)).status).toBe(204);
    expect((await saswat.get(`${HQ}/auth/me`)).status).toBe(403);
    expect((await saswat.get(`${PP}/me`)).status).toBe(200); // still a Super Admin everywhere else
    expect(await User.findOne({ email: 'saswat@test.io' }).rows()).toMatchObject({ status: 'Active', hq_seat: null, role_id: 'r-super' });
  });

  test('partner admins: the legacy single pp patch still works (View = read-only, Edit = changes)', async () => {
    const ceo = await as('ceo@test.io');
    const partnerRole = (await ceo.get(`${API}/roles`)).body.data.find((r) => r.id === 'r-partner');
    expect(partnerRole).toMatchObject({ name: 'Partner', locked: true });
    expect((await ceo.patch(`${API}/roles/r-partner`).send({ name: 'X' })).body.error.message).toBe('Partner is a locked system role');
    // { pp } applies to every partner section; c / d follow e (as pp.e allowed before).
    const viewOnly = await ceo.patch(`${API}/roles/r-pm`).send({ perms: { pp: { v: true, c: true, d: true } } });
    expect(viewOnly.status).toBe(200);
    expect(viewOnly.body.data.perms.pp).toBeUndefined();
    expect(viewOnly.body.data.perms.pp_partners).toEqual({ v: true, c: false, e: false, d: false, scope: 'all' });
    expect(viewOnly.body.data.perms.pp_settings).toEqual({ v: true, c: false, e: false, d: false, scope: 'all' });

    const { agent: pm, res } = await signIn('pm@test.io');
    expect(res.body.data.user.apps.partners).toBe('admin');
    expect((await pm.get(`${PP}/admin/users`)).body.users.map((u) => u.email)).toContain('rohit@pp.io');
    const rohit = await PpUser.findOne({ email: 'rohit@pp.io' }).lean();
    const blocked = await pm.patch(`${PP}/admin/users/${rohit._id}`).send({ commissionRate: 0.3 });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({ error: 'Your role can’t change partners in Mariox Partners' });

    const editRole = await ceo.patch(`${API}/roles/r-pm`).send({ perms: { pp: { v: false } } });
    expect(editRole.body.data.perms.pp_partners.v).toBe(false);
    expect((await ceo.patch(`${API}/roles/r-pm`).send({ perms: { pp: { e: true } } })).body.data.perms.pp_acq).toMatchObject({ v: true, c: true, e: true, d: true }); // Edit implies View
    const edited = await pm.patch(`${PP}/admin/users/${rohit._id}`).send({ commissionRate: 0.3 });
    expect(edited.status).toBe(200);
    expect(edited.body.user.commissionRate).toBe(0.3);
  });
});

describe('partner accounts', () => {
  test('invite → set password → the portal login works', async () => {
    const savedKey = process.env.MAIN_SITE_API_KEY;
    process.env.MAIN_SITE_API_KEY = 'main-site-test-key';
    const invited = await request(app).post(`${PP}/v1/users`).set('x-api-key', 'main-site-test-key').send({ name: 'Web Partner', email: 'webp@pp.io' });
    process.env.MAIN_SITE_API_KEY = savedKey;
    expect(invited.status).toBe(201);
    const account = await User.findOne({ pp_user_id: invited.body.user.id }).rows();
    expect(account).toMatchObject({ role_id: 'r-partner', status: 'Invited', password_hash: null });
    expect((await request(app).post(`${API}/auth/login`).send({ email: 'webp@pp.io', password: 'Welcome@123' })).status).toBe(401);

    const token = invited.body.setPasswordUrl.split('token=')[1];
    const done = await request(app).post(`${PP}/auth/set-password`).send({ token, password: 'Welcome@123' });
    expect(done.status).toBe(200);
    expect(done.body.user.status).toBe('active');
    expect(cookieOf(done)).toBeTruthy();

    const { agent, res } = await signIn('webp@pp.io', 'Welcome@123');
    expect(res.body.data.user).toMatchObject({ id: account.id, apps: { partners: 'partner' }, home: '/partners/dashboard' });
    expect((await agent.get(`${PP}/me`)).body.user.email).toBe('webp@pp.io');
  });

  test('a disabled partner can’t sign in, and their open sessions end', async () => {
    const { agent: partner } = await signIn('rohit@pp.io', PP_PASSWORD);
    const { agent: ceo } = await signIn('ceo@test.io');
    const rohit = await PpUser.findOne({ email: 'rohit@pp.io' }).lean();
    expect((await ceo.patch(`${PP}/admin/users/${rohit._id}`).send({ status: 'disabled' })).status).toBe(200);

    expect((await User.findOne({ id: 'u-rohit' }).rows()).status).toBe('Deactivated');
    expect(await RefreshToken.countDocuments({ user_id: 'u-rohit', revoked_at: null })).toBe(0);
    expect((await partner.get(`${PP}/me`)).status).toBe(401);
    const login = await request(app).post(`${API}/auth/login`).send({ email: 'rohit@pp.io', password: PP_PASSWORD });
    expect(login.status).toBe(401);
    expect(login.body.error.message).toBe('This account is deactivated. Ask an admin to activate it.');

    // Reactivating the account in Users & roles reactivates the partner.
    expect((await (await as('ceo@test.io')).post(`${API}/users/u-rohit/reactivate`)).status).toBe(200);
    expect((await PpUser.findById(rohit._id).lean()).status).toBe('active');
    await signIn('rohit@pp.io', PP_PASSWORD);
  });

  test('partners are not staff: no reportees, no team-task assignees, managed only in Mariox Partners', async () => {
    await User.updateOne({ id: 'u-rohit' }, { reports_to: 'u-mj' });
    const pm = (await signIn('pm@test.io')).res.body.data.user;
    expect(pm.reportees.map((r) => r.id)).not.toContain('u-rohit');
    const assignees = await (await as('ceo@test.io')).get(`${API}/team-tasks/assignees`);
    expect(assignees.status).toBe(200);
    expect(assignees.body.data.map((a) => a.id)).not.toContain('u-rohit');

    const ceo = await as('ceo@test.io');
    expect((await ceo.patch(`${API}/users/u-rohit`).send({ role: 'r-tm' })).body.error.message).toBe('Partner accounts are managed in Mariox Partners.');
    expect((await ceo.post(`${API}/users`).send({ name: 'P', email: 'p@x.io', role: 'r-partner', sendInvite: true })).status).toBe(422);
  });
});
