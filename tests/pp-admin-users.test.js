import request from 'supertest';
import { app, closeDb } from './helpers.js';
import { LOGIN, PP, ppAgent, ppReset } from './pp-helpers.js';
import { PpBooking, PpFile, PpLead, PpProject, PpUser, User } from '../src/db/models/index.js';
import { sentMail, useTestTransport } from '../src/core/mailer.js';

let ids;
let admin;
let partner;
beforeAll(async () => {
  ids = await ppReset();
  admin = await ppAgent('admin@pp.io');
  partner = await ppAgent('rohit@pp.io');
});
afterAll(closeDb);

describe('partner vs admin access', () => {
  test.each([
    ['get', '/admin/users'], ['post', '/admin/users'], ['get', '/admin/users/x'], ['patch', '/admin/users/x'], ['delete', '/admin/users/x'],
    ['get', '/admin/acquisition'], ['post', '/admin/acquisition'], ['put', '/admin/acquisition/settings'], ['post', '/admin/acquisition/sample'],
    ['post', '/admin/acquisition/import'], ['patch', '/admin/acquisition/x'], ['delete', '/admin/acquisition/x'],
    ['put', '/settings'], ['post', '/projects'], ['patch', '/projects/x'], ['delete', '/projects/x'],
    ['post', '/resources'], ['patch', '/resources/x'], ['delete', '/resources/x'],
  ])('partner %s %s → 403 Admins only', async (method, path) => {
    const res = await partner[method](`${PP}${path}`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admins only' });
  });

  test.each([['get', '/admin/users'], ['get', '/leads'], ['get', '/projects'], ['get', '/settings'], ['get', '/resources'], ['get', '/requests/scope'], ['post', '/uploads']])(
    'signed out %s %s → 401', async (method, path) => {
      expect((await request(app)[method](`${PP}${path}`)).status).toBe(401);
    },
  );

  test('an internal-portal bearer token is not a partner session', async () => {
    const res = await request(app).get(`${PP}/me`).set('Authorization', 'Bearer abc');
    expect(res.status).toBe(401);
  });
});

describe('admin users', () => {
  test('list protocol: paging, search, filters, sort', async () => {
    const all = await admin.get(`${PP}/admin/users`);
    expect(all.body.meta).toBeUndefined();
    expect(all.body.users).toHaveLength(4);
    expect(all.body.users.every((u) => u.id && !('passwordHash' in u))).toBe(true);

    const paged = await admin.get(`${PP}/admin/users?page=2&limit=10&role=partner&sort=name`);
    expect(paged.body.meta).toEqual({ page: 2, limit: 10, total: 3, pages: 1 });
    expect(paged.body.users).toEqual([]);
    const p1 = await admin.get(`${PP}/admin/users?page=1&limit=10&role=partner&sort=name`);
    expect(p1.body.users.map((u) => u.name)).toEqual(['Gone Partner', 'Rohit Sharma', 'Sana Khan']);
    const odd = await admin.get(`${PP}/admin/users?page=1&limit=7`);
    expect(odd.body.meta.limit).toBe(25); // limit must be 10/25/50/100

    expect((await admin.get(`${PP}/admin/users?q=khan`)).body.users.map((u) => u.email)).toEqual(['sana@pp.io']);
    expect((await admin.get(`${PP}/admin/users?q=MX-P-243-1`)).body.users.map((u) => u.email)).toEqual(['rohit@pp.io']);
    expect((await admin.get(`${PP}/admin/users?status=active,disabled&role=partner&sort=-name`)).body.users.map((u) => u.name)).toEqual(['Sana Khan', 'Rohit Sharma', 'Gone Partner']);
    expect((await admin.get(`${PP}/admin/users?source=seed`)).body.users).toHaveLength(2);
  });

  test('GET one; unknown id → 404', async () => {
    expect((await admin.get(`${PP}/admin/users/${ids.sana}`)).body.user.email).toBe('sana@pp.io');
    const missing = await admin.get(`${PP}/admin/users/64b000000000000000000000`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('User not found');
    expect((await admin.get(`${PP}/admin/users/not-an-id`)).status).toBe(404);
  });

  test('create: active partner with the next code, welcome email, 409 on duplicate email', async () => {
    useTestTransport();
    const res = await admin.post(`${PP}/admin/users`).send({ name: 'Neha Verma', email: 'Neha@PP.io', password: 'Start@123', phone: '9812345678', company: 'Verma Co' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'neha@pp.io', partnerCode: 'MX-P-243-4', status: 'active', source: 'admin', role: 'partner', commissionRate: 0.5, phone: '+91 9812345678' });
    expect(res.body.setPasswordUrl).toBeNull();
    expect(res.body.mail).toEqual({ sent: true, to: 'neha@pp.io' });
    expect(sentMail[0].subject).toBe('Welcome to the Mariox Partner Program – your login details');
    expect(sentMail[0].text).toContain('Password: Start@123');
    await ppAgent('neha@pp.io', 'Start@123');

    const dup = await admin.post(`${PP}/admin/users`).send({ name: 'Neha Two', email: 'neha@pp.io', password: 'Start@123' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('A user with this email already exists');
    const noPw = await admin.post(`${PP}/admin/users`).send({ name: 'No Password', email: 'np@pp.io' });
    expect(noPw.status).toBe(400);
  });

  test('partner codes continue after the highest existing one', async () => {
    const res = await admin.post(`${PP}/admin/users`).send({ name: 'Arun Das', email: 'arun@pp.io', password: 'Start@123' });
    expect(res.body.user.partnerCode).toBe('MX-P-243-5');
  });

  test('PATCH: rate, status, password (+ email), cannot suspend yourself', async () => {
    useTestTransport();
    const me = await admin.patch(`${PP}/admin/users/${ids.admin}`).send({ status: 'disabled' });
    expect(me.status).toBe(400);
    expect(me.body.error).toBe("You can't suspend your own account");

    const rate = await admin.patch(`${PP}/admin/users/${ids.sana}`).send({ commissionRate: 0.35, email: 'SANA2@pp.io' });
    expect(rate.body.user).toMatchObject({ commissionRate: 0.35, email: 'sana2@pp.io' });
    expect((await admin.patch(`${PP}/admin/users/${ids.sana}`).send({ commissionRate: 2 })).status).toBe(400);

    const sana = await ppAgent('sana2@pp.io');
    const pw = await admin.patch(`${PP}/admin/users/${ids.sana}`).send({ password: 'Admin@Set1', emailPassword: true });
    expect(pw.body.mail).toEqual({ sent: true, to: 'sana2@pp.io' });
    expect(sentMail.at(-1).subject).toBe('Your Mariox partner password was changed');
    expect((await sana.get(`${PP}/me`)).status).toBe(401); // sessionVersion bumped
    await ppAgent('sana2@pp.io', 'Admin@Set1');

    const off = await admin.patch(`${PP}/admin/users/${ids.sana}`).send({ status: 'disabled' });
    expect(off.body.user.status).toBe('disabled');
    // Suspended partner = deactivated Mariox One account: the one login refuses it.
    const refused = await request(app).post(LOGIN).send({ email: 'sana2@pp.io', password: 'Admin@Set1' });
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toBe('This account is deactivated. Ask an admin to activate it.');
    await admin.patch(`${PP}/admin/users/${ids.sana}`).send({ status: 'active' });
    expect((await User.findOne({ pp_user_id: ids.sana }).rows())).toMatchObject({ email: 'sana2@pp.io', status: 'Active' });
  });

  test('DELETE: not yourself, not with projects; otherwise removes leads, requests and files', async () => {
    expect((await admin.delete(`${PP}/admin/users/${ids.admin}`)).body.error).toBe("You can't delete your own account");

    await PpProject.create({ owner: ids.sana, client: 'Acme', title: 'Shop app', deal: 100 });
    const refused = await admin.delete(`${PP}/admin/users/${ids.sana}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('This partner has 1 project(s) with payment records. Suspend them instead, or delete the projects first.');

    const gone = await PpUser.findOne({ email: 'gone@pp.io' }).lean();
    await PpLead.create({ owner: gone._id, company: 'Old Co' });
    await PpBooking.create({ owner: gone._id, client: 'Old Co' });
    await PpFile.create({ owner: gone._id, key: 'uploads/x/gone.pdf', name: 'gone.pdf', size: 1 });
    const ok = await admin.delete(`${PP}/admin/users/${gone._id}`);
    expect(ok.body).toEqual({ ok: true });
    expect(await PpUser.countDocuments({ _id: gone._id })).toBe(0);
    expect(await PpLead.countDocuments({ owner: gone._id })).toBe(0);
    expect(await PpBooking.countDocuments({ owner: gone._id })).toBe(0);
    expect(await PpFile.countDocuments({ owner: gone._id })).toBe(0);
    expect(await User.countDocuments({ pp_user_id: String(gone._id) })).toBe(0); // their Mariox One account goes too
  });

  test('partner-admin profiles: email, status and password stay with the staff account', async () => {
    const res = await admin.patch(`${PP}/admin/users/${ids.admin}`).send({ password: 'Takeover@1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A partner admin’s email, status and password are managed in the team portal (Users & roles)');
  });
});

describe('main-site API (POST /pp/v1/users)', () => {
  const OLD = process.env.MAIN_SITE_API_KEY;
  beforeAll(() => { process.env.MAIN_SITE_API_KEY = 'main-site-test-key'; });
  afterAll(() => { process.env.MAIN_SITE_API_KEY = OLD; });

  test('wrong key → 401; without a password → invited with a set-password link, no email', async () => {
    useTestTransport();
    expect((await request(app).post(`${PP}/v1/users`).set('x-api-key', 'nope').send({ name: 'Web User', email: 'web@pp.io' })).body).toEqual({ error: 'Invalid API key' });
    const res = await request(app).post(`${PP}/v1/users`).set('x-api-key', 'main-site-test-key').send({ name: 'Web User', email: 'web@pp.io', externalId: 'ext-1' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ status: 'invited', source: 'main-site', externalId: 'ext-1' });
    expect(res.body.setPasswordUrl).toMatch(/set-password\?token=/);
    expect(sentMail).toHaveLength(0);
    // Like an invite: an invited Mariox One partner account is created with the profile.
    expect(await User.findOne({ pp_user_id: res.body.user.id }).rows()).toMatchObject({ email: 'web@pp.io', role_id: 'r-partner', status: 'Invited' });
  });
});
