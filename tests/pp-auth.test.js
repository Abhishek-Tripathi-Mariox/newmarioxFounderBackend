import request from 'supertest';
import { app, closeDb } from './helpers.js';
import { LOGIN, PP, PP_PASSWORD, addPartner, ppAgent, ppReset } from './pp-helpers.js';
import { PasswordReset, PpUser, User } from '../src/db/models/index.js';
import { sentMail, useTestTransport } from '../src/core/mailer.js';

let ids;
beforeAll(async () => { ids = await ppReset(); });
afterAll(closeDb);

const cookieOf = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('mx_refresh='));

describe('sign-in (the one Mariox One login) / logout / me', () => {
  test('wrong password → 401, unknown email → 401, disabled partner → 401 deactivated', async () => {
    let res = await request(app).post(LOGIN).send({ email: 'rohit@pp.io', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
    res = await request(app).post(LOGIN).send({ email: 'nobody@pp.io', password: 'x' });
    expect(res.status).toBe(401);
    res = await request(app).post(LOGIN).send({ email: 'gone@pp.io', password: PP_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('This account is deactivated. Ask an admin to activate it.');
  });

  test('the partner portal has no login of its own any more', async () => {
    const res = await request(app).post(`${PP}/auth/login`).send({ email: 'rohit@pp.io', password: PP_PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('portal login sets the httpOnly mx_refresh session for /api/v1, lands partners on Partners; /pp/me is their profile', async () => {
    const agent = request.agent(app);
    const res = await agent.post(LOGIN).send({ email: 'ROHIT@pp.io', password: PP_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      id: 'u-rohit', role: { id: 'r-partner', name: 'Partner' },
      apps: { portal: false, partners: 'partner', founders: null }, home: '/partners/dashboard',
    });
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1(;|$)/);
    expect(cookie).toMatch(/Max-Age=604800/);

    const me = await agent.get(`${PP}/me`);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({
      id: ids.rohit, email: 'rohit@pp.io', role: 'partner', partnerCode: 'MX-P-243-1',
      apps: { portal: false, partners: 'partner', founders: null }, // for the app switcher
    });
    expect(me.body.user.passwordHash).toBeUndefined();
    expect((await PpUser.findById(ids.rohit).lean()).lastLoginAt).toBeTruthy();
  });

  test('GET /me needs the session; logout revokes and clears it', async () => {
    expect((await request(app).get(`${PP}/me`)).status).toBe(401);
    expect((await request(app).get(`${PP}/me`)).body).toEqual({ error: 'Not signed in' });
    const agent = await ppAgent('rohit@pp.io');
    const me = await agent.get(`${PP}/me`);
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe('Rohit Sharma');
    const out = await agent.post(`${PP}/auth/logout`);
    expect(out.body).toEqual({ ok: true });
    expect(cookieOf(out)).toMatch(/mx_refresh=;/);
    expect((await agent.get(`${PP}/me`)).status).toBe(401);
  });

  test('a suspended partner profile loses access at once (403: still signed in, no partner access)', async () => {
    const agent = await ppAgent('sana@pp.io');
    await PpUser.updateOne({ _id: ids.sana }, { status: 'disabled' });
    const res = await agent.get(`${PP}/me`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Your account is suspended');
    await PpUser.updateOne({ _id: ids.sana }, { status: 'active' });
  });

  test('PATCH /me edits profile fields only (normalised), never role or rate', async () => {
    const agent = await ppAgent('sana@pp.io');
    const res = await agent.patch(`${PP}/me`).send({ phone: '9876543210', pan: 'abcde1234f', ifsc: 'hdfc0001234', city: 'Noida', role: 'admin', commissionRate: 1 });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ phone: '+91 9876543210', pan: 'ABCDE1234F', ifsc: 'HDFC0001234', city: 'Noida', role: 'partner', commissionRate: 0.4 });
    const bad = await agent.patch(`${PP}/me`).send({ bankAccount: '12' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bankAccount: Account number is 9–18 digits');
  });

  test('POST /me/password: wrong current → 400, same → 400; success signs other devices out', async () => {
    const a = await ppAgent('sana@pp.io');
    const b = await ppAgent('sana@pp.io');
    expect((await a.post(`${PP}/me/password`).send({ currentPassword: 'wrong', newPassword: 'NewPass@123' })).body.error).toBe('Current password is wrong');
    expect((await a.post(`${PP}/me/password`).send({ currentPassword: PP_PASSWORD, newPassword: PP_PASSWORD })).body.error).toBe('Choose a password you have not used just now');
    const ok = await a.post(`${PP}/me/password`).send({ currentPassword: PP_PASSWORD, newPassword: 'NewPass@123' });
    expect(ok.status).toBe(200);
    expect((await a.get(`${PP}/me`)).status).toBe(200); // this device got a fresh cookie
    const other = await b.get(`${PP}/me`);
    expect(other.status).toBe(401);
    expect(other.body.error).toBe('Your session ended. Please sign in again.');
    await ppAgent('sana@pp.io', 'NewPass@123');
  });

  test('DELETE /me/sessions signs out every other device', async () => {
    const a = await ppAgent('rohit@pp.io');
    const b = await ppAgent('rohit@pp.io');
    expect((await a.delete(`${PP}/me/sessions`)).body).toEqual({ ok: true });
    expect((await a.get(`${PP}/me`)).status).toBe(200);
    expect((await b.get(`${PP}/me`)).status).toBe(401);
  });
});

describe('invite → set password', () => {
  beforeEach(() => useTestTransport());

  test('admin newInvite emails a 7-day link; set-password activates and signs in', async () => {
    const admin = await ppAgent('admin@pp.io');
    const created = await addPartner({ userId: 'u-ira', name: 'Invited Ira', email: 'ira@pp.io', partnerCode: 'MX-P-243-9', status: 'invited', password: null });
    const res = await admin.patch(`${PP}/admin/users/${created}`).send({ newInvite: true });
    expect(res.status).toBe(200);
    expect(res.body.mail).toEqual({ sent: true, to: 'ira@pp.io' });
    expect(res.body.setPasswordUrl).toMatch(/\/partners\/set-password\?token=[0-9a-f]{48}$/);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].subject).toBe('Your new link to set your Mariox partner password');
    expect(sentMail[0].html).toContain(res.body.setPasswordUrl);

    const token = res.body.setPasswordUrl.split('token=')[1];
    expect((await request(app).post(`${PP}/auth/set-password`).send({ token: 'x'.repeat(20), password: 'Welcome@123' })).body)
      .toEqual({ error: 'This link is invalid or has expired' });
    const short = await request(app).post(`${PP}/auth/set-password`).send({ token, password: 'short' });
    expect(short.status).toBe(400);

    const agent = request.agent(app);
    const done = await agent.post(`${PP}/auth/set-password`).send({ token, password: 'Welcome@123' });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ email: 'ira@pp.io', status: 'active' });
    expect(cookieOf(done)).toMatch(/Path=\/api\/v1(;|$)/); // signed in to Mariox One
    expect((await agent.get(`${PP}/me`)).body.user.email).toBe('ira@pp.io');
    expect(await User.findOne({ id: 'u-ira' }).rows()).toMatchObject({ status: 'Active' });
    // The link works once.
    expect((await request(app).post(`${PP}/auth/set-password`).send({ token, password: 'Welcome@123' })).status).toBe(400);
    await ppAgent('ira@pp.io', 'Welcome@123');
  });
});

describe('forgot password (code → verify → reset)', () => {
  const codeFromMail = () => /^(\d{6}) is your Mariox password reset code$/.exec(sentMail.at(-1).subject)[1];

  const GENERIC = { sent: true, expiresIn: 600, resendIn: 60 };

  test('unknown and disabled emails get the same answer as real ones, and no email', async () => {
    useTestTransport();
    const none = await request(app).post(`${PP}/auth/forgot`).send({ email: 'none@pp.io' });
    expect(none.status).toBe(200);
    expect(none.body).toEqual(GENERIC);
    const gone = await request(app).post(`${PP}/auth/forgot`).send({ email: 'gone@pp.io' });
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual(GENERIC);
    expect(sentMail).toHaveLength(0);
    expect((await request(app).post(`${PP}/auth/forgot`).send({ email: 'none@pp.io' })).status).toBe(429); // same cooldown too
  });

  test('team accounts (here a partner admin) reset by code too: one flow for every account', async () => {
    useTestTransport();
    const res = await request(app).post(`${PP}/auth/forgot`).send({ email: 'Admin@pp.io' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(GENERIC);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('admin@pp.io');
  });

  test('a failed email still gets the generic answer (nothing revealed)', async () => {
    useTestTransport({ fail: true });
    const res = await request(app).post(`${PP}/auth/forgot`).send({ email: 'sana@pp.io' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(GENERIC);
    await PasswordReset.deleteMany({});
  });

  test('full flow: throttle, wrong-code counter, token, reset signs out everywhere', async () => {
    useTestTransport();
    const old = await ppAgent('rohit@pp.io');
    const sent = await request(app).post(`${PP}/auth/forgot`).send({ email: 'rohit@pp.io' });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: true, expiresIn: 600, resendIn: 60 });
    expect(sentMail).toHaveLength(1);
    const code = codeFromMail();

    const again = await request(app).post(`${PP}/auth/forgot`).send({ email: 'rohit@pp.io' });
    expect(again.status).toBe(429);
    expect(again.body.error).toMatch(/^Please wait \d+ seconds before asking for a new code$/);

    const wrong = code === '000000' ? '111111' : '000000';
    const w1 = await request(app).post(`${PP}/auth/forgot/verify`).send({ email: 'rohit@pp.io', otp: wrong });
    expect(w1.status).toBe(400);
    expect(w1.body.error).toBe('Wrong code. 4 tries left.');
    expect((await request(app).post(`${PP}/auth/forgot/verify`).send({ email: 'rohit@pp.io', otp: '12' })).body.error).toBe('otp: Enter the 6-digit code');

    const ok = await request(app).post(`${PP}/auth/forgot/verify`).send({ email: 'rohit@pp.io', otp: code });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toMatch(/^[0-9a-f]{48}$/);
    // The code is used up.
    expect((await request(app).post(`${PP}/auth/forgot/verify`).send({ email: 'rohit@pp.io', otp: code })).body.error).toBe('This code has expired. Ask for a new one.');

    expect((await request(app).post(`${PP}/auth/forgot/reset`).send({ email: 'rohit@pp.io', token: 'f'.repeat(48), password: 'Reset@1234' })).body.error)
      .toBe('This reset has expired. Start again.');
    const reset = await request(app).post(`${PP}/auth/forgot/reset`).send({ email: 'rohit@pp.io', token: ok.body.token, password: 'Reset@1234' });
    expect(reset.body).toEqual({ ok: true });
    expect((await old.get(`${PP}/me`)).status).toBe(401);
    await ppAgent('rohit@pp.io', 'Reset@1234');
    expect((await request(app).post(LOGIN).send({ email: 'rohit@pp.io', password: PP_PASSWORD })).status).toBe(401);
  });

  test('five wrong codes lock the code → 429', async () => {
    useTestTransport();
    await request(app).post(`${PP}/auth/forgot`).send({ email: 'sana@pp.io' });
    const code = codeFromMail();
    const wrong = code === '000000' ? '111111' : '000000';
    const msgs = [];
    for (let i = 0; i < 5; i++) msgs.push((await request(app).post(`${PP}/auth/forgot/verify`).send({ email: 'sana@pp.io', otp: wrong })).body.error);
    expect(msgs).toEqual(['Wrong code. 4 tries left.', 'Wrong code. 3 tries left.', 'Wrong code. 2 tries left.', 'Wrong code. 1 try left.', 'Too many wrong codes. Ask for a new one.']);
    const locked = await request(app).post(`${PP}/auth/forgot/verify`).send({ email: 'sana@pp.io', otp: code });
    expect(locked.status).toBe(429);
  });
});

test('unknown /pp route → 404 in the portal error shape', async () => {
  const res = await request(app).get(`${PP}/nope`);
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'Not found' });
});
