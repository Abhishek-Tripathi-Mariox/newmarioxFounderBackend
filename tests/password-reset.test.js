import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app, closeDb, PASSWORD, resetDb } from './helpers.js';
import { addPartner } from './pp-helpers.js';
import { AuditLog, PasswordReset, RefreshToken, User } from '../src/db/models/index.js';
import { sentMail, useTestTransport } from '../src/core/mailer.js';
import { deliverCode } from '../src/modules/auth/passwordReset.js';

/** Self-service forgot password for every account: POST /api/v1/auth/forgot → /verify → /reset. */
const A = '/api/v1/auth';
const GENERIC = { sent: true, expiresIn: 600, resendIn: 60 };
const NEW_PW = 'Fresh@Pass1';

const forgot = (email) => request(app).post(`${A}/forgot`).send({ email });
const verify = (email, code) => request(app).post(`${A}/forgot/verify`).send({ email, code });
const reset = (token, password = NEW_PW) => request(app).post(`${A}/forgot/reset`).send({ token, password });
const login = (email, password) => request(app).post(`${A}/login`).send({ email, password });
const lastCode = () => /^(\d{6}) is your Mariox password reset code$/.exec(sentMail.at(-1).subject)[1];
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');

/** Ask for a code and verify it → reset token. */
async function tokenFor(email) {
  expect((await forgot(email)).body).toEqual({ data: GENERIC });
  const res = await verify(email, lastCode());
  expect(res.status).toBe(200);
  return res.body.data.token;
}

beforeAll(async () => {
  await resetDb();
  await User.updateOne({ id: 'u-ceo' }, { hq_seat: 'rahul' }); // the Founder
  await addPartner({ userId: 'u-part', name: 'Pia Partner', email: 'pia@partner.io', partnerCode: 'MX-P-243-7', source: 'admin' });
  await User.insertMany([{ id: 'u-inv', name: 'Ivy Invited', email: 'ivy@test.io', role_id: 'r-tm', status: 'Invited', password_hash: await bcrypt.hash(PASSWORD, 4) }]);
});
beforeEach(() => useTestTransport());
afterAll(closeDb);

describe('every kind of account can reset its own password', () => {
  test.each([
    ['founder', 'ceo@test.io', 'u-ceo'],
    ['team member', 'dev@test.io', 'u-vg'],
    ['client', 'client@test.io', 'u-cl1'],
    ['partner', 'pia@partner.io', 'u-part'],
  ])('%s: code by email → token → new password; signed out everywhere; audited; told by email', async (_kind, email, userId) => {
    const agent = request.agent(app);
    expect((await agent.post(`${A}/login`).send({ email, password: email === 'pia@partner.io' ? 'Partner@123' : PASSWORD })).status).toBe(200);

    const sent = await forgot(email.toUpperCase());
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ data: GENERIC });
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe(email);
    const code = lastCode();
    expect(sentMail[0].html).toContain(code);
    const row = await PasswordReset.findOne({ user_id: userId }).lean();
    expect(row.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code); // stored hashed only
    expect(JSON.stringify(row)).not.toContain(email);

    const ok = await verify(email, code);
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toMatch(/^[0-9a-f]{48}$/);

    const done = await reset(ok.body.data.token);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ data: { ok: true } });

    expect(await RefreshToken.countDocuments({ user_id: userId, revoked_at: null })).toBe(0);
    expect((await agent.post(`${A}/refresh`)).status).toBe(401);
    expect((await login(email, NEW_PW)).status).toBe(200);
    expect((await login(email, PASSWORD)).status).toBe(401);
    expect(await AuditLog.findOne({ actor_user_id: userId, kind: 'Credentials' }).lean()).toMatchObject({ text: expect.stringContaining('reset their password') });
    expect(sentMail.at(-1)).toMatchObject({ to: email, subject: expect.stringMatching(/password was changed$/) });
  });
});

describe('no account enumeration', () => {
  test('unknown, Deactivated and Invited emails: same 200 answer, no email, and the steps after fail the same way', async () => {
    for (const email of ['nobody@test.io', 'off@test.io', 'ivy@test.io']) {
      const res = await forgot(email);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: GENERIC });
      // Same cooldown as a real account.
      expect((await forgot(email)).status).toBe(429);
      // Wrong-code counting looks the same too.
      const w = await verify(email, '123456');
      expect(w.status).toBe(400);
      expect(w.body.error.message).toBe('Wrong code. 4 tries left.');
    }
    expect(sentMail).toHaveLength(0);
  });

  test('a decoy document can never reset anything (even with a valid token)', async () => {
    await forgot('nobody2@test.io');
    const row = await PasswordReset.findOne({ user_id: null, token_hash: null }).lean();
    // Pretend someone got through verification for a deactivated account.
    await PasswordReset.updateOne({ _id: row._id }, { user_id: 'u-off', otp_hash: null, token_hash: (await import('../src/core/tokens.js')).hashToken('t'.repeat(48)), token_expires_at: new Date(Date.now() + 6e5) });
    const res = await reset('t'.repeat(48));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('This reset has expired. Start again.');
    expect((await login('off@test.io', NEW_PW)).status).toBe(401);
    expect((await User.findOne({ id: 'u-inv' }).rows()).status).toBe('Invited');
  });

  test('a bad email shape is a validation error, not a hint', async () => {
    const res = await forgot('not-an-email');
    expect(res.status).toBe(422);
  });
});

describe('code rules', () => {
  test('resend cooldown: 60 s per address', async () => {
    await forgot('dev2@test.io');
    const again = await forgot('dev2@test.io');
    expect(again.status).toBe(429);
    expect(again.body.error.message).toMatch(/^Please wait \d+ seconds before asking for a new code$/);
    expect(sentMail).toHaveLength(1);
    // After the cooldown a new code replaces the old one.
    const first = lastCode();
    await PasswordReset.updateMany({ user_id: 'u-si' }, { sent_at: new Date(Date.now() - 61e3) });
    expect((await forgot('dev2@test.io')).status).toBe(200);
    expect(sentMail).toHaveLength(2);
    const second = lastCode();
    if (first !== second) expect((await verify('dev2@test.io', first)).body.error.message).toBe('Wrong code. 4 tries left.');
  });

  test('five wrong codes lock the code, even the right one then fails', async () => {
    await PasswordReset.deleteMany({});
    await forgot('qa@test.io');
    const code = lastCode();
    const msgs = [];
    for (let i = 0; i < 5; i++) msgs.push((await verify('qa@test.io', wrongFor(code))).body.error.message);
    expect(msgs).toEqual(['Wrong code. 4 tries left.', 'Wrong code. 3 tries left.', 'Wrong code. 2 tries left.', 'Wrong code. 1 try left.', 'Too many wrong codes. Ask for a new one.']);
    const locked = await verify('qa@test.io', code);
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toBe('Too many wrong codes. Ask for a new one.');
  });

  test('the code expires after 10 minutes', async () => {
    await forgot('pm@test.io');
    const code = lastCode();
    const row = await PasswordReset.findOne({ user_id: 'u-mj' }).lean();
    expect(row.otp_expires_at.getTime() - Date.now()).toBeGreaterThan(9.9 * 6e4);
    expect(row.otp_expires_at.getTime() - Date.now()).toBeLessThanOrEqual(10 * 6e4);
    await PasswordReset.updateOne({ _id: row._id }, { otp_expires_at: new Date(Date.now() - 1000) });
    const res = await verify('pm@test.io', code);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('This code has expired. Ask for a new one.');
  });

  test('the code and the reset token each work once; an expired token fails', async () => {
    await PasswordReset.deleteMany({});
    await forgot('se@test.io');
    const code = lastCode();
    const token = (await verify('se@test.io', code)).body.data.token;
    expect((await verify('se@test.io', code)).body.error.message).toBe('This code has expired. Ask for a new one.');
    expect((await reset(token)).status).toBe(200);
    const twice = await reset(token, 'Another@Pass2');
    expect(twice.status).toBe(400);
    expect(twice.body.error.message).toBe('This reset has expired. Start again.');
    expect((await login('se@test.io', NEW_PW)).status).toBe(200);

    const t2 = await tokenFor('sm@test.io');
    await PasswordReset.updateOne({ user_id: 'u-ak' }, { token_expires_at: new Date(Date.now() - 1000) });
    expect((await reset(t2)).body.error.message).toBe('This reset has expired. Start again.');
    expect((await login('sm@test.io', PASSWORD)).status).toBe(200);
  });

  test('the new password follows the portal rules', async () => {
    const token = await tokenFor('admin@test.io');
    expect((await reset(token, 'short')).status).toBe(422);
    expect((await reset(token, 'x'.repeat(129))).status).toBe(422);
    expect((await reset(token, 'LongEnough1')).status).toBe(200);
  });

  test('an account deactivated after asking for a code cannot finish', async () => {
    await User.insertMany([{ id: 'u-late', name: 'Late Leaver', email: 'late@test.io', role_id: 'r-tm', status: 'Active', password_hash: await bcrypt.hash(PASSWORD, 4) }]);
    const token = await tokenFor('late@test.io');
    await User.updateOne({ id: 'u-late' }, { status: 'Deactivated' });
    expect((await reset(token)).body.error.message).toBe('This reset has expired. Start again.');
  });
});

describe('without email', () => {
  const capture = () => {
    const lines = [];
    const rec = (...args) => lines.push(JSON.stringify(args));
    return { lines, log: { warn: rec, error: rec, info: rec } };
  };
  const user = { id: 'u-x', name: 'X', email: 'x@test.io' };

  test('production never logs the code', async () => {
    const { lines, log } = capture();
    expect(await deliverCode(user, '424242', { isProd: true, mailOn: false, log })).toBe(false);
    expect(lines.join('\n')).not.toContain('424242');
    expect(lines.join('\n')).toMatch(/email is not configured/);
  });

  test('development logs it, clearly marked dev only', async () => {
    const { lines, log } = capture();
    await deliverCode(user, '424242', { isProd: false, mailOn: false, log });
    expect(lines.join('\n')).toMatch(/DEV ONLY.*424242/);
  });

  test('with email set up the code is only emailed', async () => {
    const { lines, log } = capture();
    expect(await deliverCode(user, '424242', { isProd: false, mailOn: true, log })).toBe(true);
    expect(lines).toHaveLength(0);
    expect(sentMail.at(-1).subject).toBe('424242 is your Mariox password reset code');
  });
});
