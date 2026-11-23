import request from 'supertest';
import { RefreshToken, User } from '../src/db/models/index.js';
import { closeDb, createTestUser, DEFAULT_PASSWORD, HQ, LOGIN, loginAgent, makeApp, resetHqDb, sessionCookieHeader } from './hq-helpers.js';

const EMAIL = 'rahul@example.com';

let app;
beforeEach(async () => {
  await resetHqDb();
  app = makeApp();
  await createTestUser({ email: EMAIL });
});
afterAll(closeDb);

describe('sign-in is the one Mariox One login', () => {
  test('the HQ has no login of its own any more (404)', async () => {
    const res = await request(app).post(`${HQ}/auth/login`).send({ email: EMAIL, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('a founder signs in at the portal login: session cookie for /api/v1, lands on /founders', async () => {
    const res = await request(app).post(LOGIN).send({ email: '  RAHUL@example.com ', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ isSuper: true, apps: { portal: true, partners: 'admin', founders: 'rahul' }, home: '/founders' });

    const cookie = sessionCookieHeader(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1(;|$)/);
    expect(cookie).toMatch(/Max-Age=604800/);
    expect(cookie).not.toMatch(/Secure/i); // only with COOKIE_SECURE=true or in production
  });
});

describe('session', () => {
  test('GET /hq/auth/me returns the signed-in founder', async () => {
    const agent = await loginAgent(app, EMAIL);
    const res = await agent.get(`${HQ}/auth/me`);
    expect(res.status).toBe(200);
    const { user } = res.body.data;
    expect(Object.keys(user).sort()).toEqual(['createdAt', 'email', 'id', 'lastLoginAt', 'name', 'seat', 'seatLabel']);
    expect(user.email).toBe(EMAIL);
    expect(user.seat).toBe('rahul');
    expect(user.seatLabel).toBe('Founder');
    expect(Date.parse(user.lastLoginAt)).toBeTruthy();
    expect(user.passwordHash).toBeUndefined();
  });

  test('also accepts the portal Bearer access token', async () => {
    const login = await request(app).post(LOGIN).send({ email: EMAIL, password: DEFAULT_PASSWORD });
    const res = await request(app).get(`${HQ}/auth/me`).set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.seat).toBe('rahul');
  });

  test('rejects requests without a session (401)', async () => {
    const res = await request(app).get(`${HQ}/auth/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Please sign in to continue.');
  });

  test('rejects an unknown session cookie (401)', async () => {
    expect((await request(app).get(`${HQ}/auth/me`).set('Cookie', 'mx_refresh=not-a-session')).status).toBe(401);
  });

  test('ends access immediately when the account is deactivated', async () => {
    const agent = await loginAgent(app, EMAIL);
    await User.updateOne({ email: EMAIL }, { status: 'Deactivated' });
    const res = await agent.get(`${HQ}/auth/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Your session has ended. Please sign in again.');
  });

  test('rejects a revoked session', async () => {
    const agent = await loginAgent(app, EMAIL);
    await RefreshToken.updateMany({}, { revoked_at: new Date() });
    expect((await agent.get(`${HQ}/auth/me`)).status).toBe(401);
  });

  test('POST /hq/auth/logout is the portal sign-out: revokes and clears the session (204)', async () => {
    const agent = await loginAgent(app, EMAIL);
    const res = await agent.post(`${HQ}/auth/logout`);
    expect(res.status).toBe(204);
    const cookie = sessionCookieHeader(res);
    expect(cookie).toMatch(/mx_refresh=;/);
    expect(cookie).toMatch(/Path=\/api\/v1(;|$)/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await agent.get(`${HQ}/auth/me`)).status).toBe(401);
    expect(await RefreshToken.countDocuments({ revoked_at: null })).toBe(0);
  });
});

describe('POST /hq/auth/change-password (the Mariox One password)', () => {
  test('changes the password, ends other sessions and keeps the current one', async () => {
    const current = await loginAgent(app, EMAIL);
    const other = await loginAgent(app, EMAIL);

    const res = await current.post(`${HQ}/auth/change-password`).send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(204);
    expect(sessionCookieHeader(res)).toBeTruthy();

    expect((await current.get(`${HQ}/auth/me`)).status).toBe(200);
    expect((await other.get(`${HQ}/auth/me`)).status).toBe(401);

    expect((await request(app).post(LOGIN).send({ email: EMAIL, password: DEFAULT_PASSWORD })).status).toBe(401);
    expect((await request(app).post(LOGIN).send({ email: EMAIL, password: 'a-brand-new-password' })).status).toBe(200);
  });

  test('returns 400 when the current password is wrong', async () => {
    const agent = await loginAgent(app, EMAIL);
    const res = await agent.post(`${HQ}/auth/change-password`).send({ currentPassword: 'definitely-wrong', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Your current password is not right.');
  });

  test('returns 422 when the new password is too short', async () => {
    const agent = await loginAgent(app, EMAIL);
    const res = await agent.post(`${HQ}/auth/change-password`).send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Password must be at least 8 characters.');
  });

  test('requires a session (401)', async () => {
    const res = await request(app).post(`${HQ}/auth/change-password`).send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);
  });
});
