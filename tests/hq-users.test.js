import request from 'supertest';
import { User } from '../src/db/models/index.js';
import { closeDb, createTestUser, DEFAULT_PASSWORD, resetHqDb, HQ, loginAgent, makeApp, sessionCookieHeader } from './hq-helpers.js';

const MISSING_ID = '0123456789abcdef01234567';

let app;
let rahul;
let rahulAgent;

beforeEach(async () => {
  await resetHqDb();
  app = makeApp();
  rahul = await createTestUser({ name: 'Rahul Garg', email: 'rahul@example.com', seat: 'rahul' });
  rahulAgent = await loginAgent(app, 'rahul@example.com');
});
afterAll(closeDb);

const addSaswat = () => createTestUser({ name: 'Saswat', email: 'saswat@example.com', seat: 'saswat' });

test('requires a session for every users route (401)', async () => {
  expect((await request(app).get(`${HQ}/users`)).status).toBe(401);
  expect((await request(app).post(`${HQ}/users`).send({})).status).toBe(401);
  expect((await request(app).patch(`${HQ}/users/${rahul.id}`).send({ name: 'x' })).status).toBe(401);
  expect((await request(app).post(`${HQ}/users/${rahul.id}/password`).send({ password: 'whatever1' })).status).toBe(401);
  expect((await request(app).delete(`${HQ}/users/${rahul.id}`)).status).toBe(401);
});

describe('GET /hq/users', () => {
  test('lists accounts with the founder seat first and no secrets', async () => {
    await addSaswat();
    const res = await rahulAgent.get(`${HQ}/users`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((user) => [user.seat, user.seatLabel])).toEqual([['rahul', 'Founder'], ['saswat', 'Co-founder']]);
    for (const user of res.body.data) {
      expect(user.passwordHash).toBeUndefined();
      expect(user.sessionVersion).toBeUndefined();
      expect(user.prefs).toBeUndefined();
    }
  });
});

describe('POST /hq/users (accounts are created inside the HQ)', () => {
  test('creates a Mariox One Super Admin holding the seat', async () => {
    const res = await rahulAgent.post(`${HQ}/users`).send({ name: 'Saswat', email: 'saswat@example.com', password: 'a-good-password', seat: 'saswat' });
    expect(res.status).toBe(201);
    expect(await User.findOne({ email: 'saswat@example.com' }).rows()).toMatchObject({ role_id: 'r-super', title: 'Co-founder', hq_seat: 'saswat', status: 'Active' });
  });

  test('only a Super Admin may manage HQ accounts (403)', async () => {
    const saswat = await addSaswat();
    await User.updateOne({ email: 'rahul@example.com' }, { role_id: 'r-admin' });
    const res = await rahulAgent.post(`${HQ}/users`).send({ name: 'X', email: 'x@example.com', password: 'a-good-password' });
    expect(res.status).toBe(403);
    expect((await rahulAgent.delete(`${HQ}/users/${saswat.id}`)).status).toBe(403);
    expect((await rahulAgent.get(`${HQ}/users`)).status).toBe(200); // the seat still opens the HQ
  });

  test('creates a co-founder by default, with a person id of their own (201)', async () => {
    const res = await rahulAgent.post(`${HQ}/users`).send({ name: 'Saswat', email: 'Saswat@Example.com', password: 'a-good-password' });
    expect(res.status).toBe(201);
    expect(res.body.data.seat).toBe(res.body.data.userId);
    expect(res.body.data.role).toBe('cofounder');
    expect(res.body.data.seatLabel).toBe('Co-founder');
    expect(res.body.data.email).toBe('saswat@example.com');
    expect(res.body.data.lastLoginAt).toBeNull();
    expect(res.body.data.password).toBeUndefined();

    await loginAgent(app, 'saswat@example.com', 'a-good-password');
  });

  test('there is no limit: a third and fourth member can be added next to both original seats', async () => {
    await addSaswat();
    const third = await rahulAgent.post(`${HQ}/users`).send({ name: 'Third', email: 'third@example.com', password: 'a-good-password', role: 'founder' });
    expect(third.status).toBe(201);
    expect(third.body.data).toMatchObject({ role: 'founder', seatLabel: 'Founder' });
    const fourth = await rahulAgent.post(`${HQ}/users`).send({ name: 'Fourth', email: 'fourth@example.com', password: 'a-good-password' });
    expect(fourth.status).toBe(201);
    expect((await rahulAgent.get(`${HQ}/users`)).body.data).toHaveLength(4);
  });

  test('returns 409 when the requested seat is taken', async () => {
    const res = await rahulAgent.post(`${HQ}/users`).send({ name: 'Other', email: 'other@example.com', password: 'a-good-password', seat: 'rahul' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('The Founder seat is already taken.');
  });

  test('returns 409 for a duplicate email', async () => {
    const res = await rahulAgent.post(`${HQ}/users`).send({ name: 'Dup', email: 'RAHUL@example.com', password: 'a-good-password' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('An account with this email already exists.');
  });

  test('returns 422 for invalid input', async () => {
    const res = await rahulAgent.post(`${HQ}/users`).send({ name: '', email: 'nope', password: 'short', seat: 'ceo' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((detail) => detail.path).sort()).toEqual(['body.email', 'body.name', 'body.password', 'body.seat']);
  });
});

describe('PATCH /hq/users/:id', () => {
  test('updates name and email (200)', async () => {
    const saswat = await addSaswat();
    const res = await rahulAgent.patch(`${HQ}/users/${saswat.id}`).send({ name: 'Saswat Kumar', email: 'saswat.k@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Saswat Kumar');
    expect(res.body.data.email).toBe('saswat.k@example.com');
    expect(res.body.data.seat).toBe('saswat');
  });

  test('returns 409 when the new email belongs to someone else', async () => {
    const saswat = await addSaswat();
    expect((await rahulAgent.patch(`${HQ}/users/${saswat.id}`).send({ email: 'rahul@example.com' })).status).toBe(409);
    // Keeping your own email is fine.
    expect((await rahulAgent.patch(`${HQ}/users/${rahul.id}`).send({ email: 'rahul@example.com' })).status).toBe(200);
  });

  test('returns 404 for an unknown account and 422 for a malformed id or empty body', async () => {
    expect((await rahulAgent.patch(`${HQ}/users/${MISSING_ID}`).send({ name: 'Ghost' })).status).toBe(404);
    const badId = await rahulAgent.patch(`${HQ}/users/not-an-id`).send({ name: 'Ghost' });
    expect(badId.status).toBe(422);
    expect(badId.body.error.details[0].path).toBe('params.id');
    const empty = await rahulAgent.patch(`${HQ}/users/${rahul.id}`).send({});
    expect(empty.status).toBe(422);
    expect(empty.body.error.message).toBe('Send a new name or email to update.');
  });
});

describe('POST /hq/users/:id/password', () => {
  test("sets another founder's password and ends their sessions (logout everywhere)", async () => {
    const saswat = await addSaswat();
    const saswatAgent = await loginAgent(app, 'saswat@example.com');

    expect((await rahulAgent.post(`${HQ}/users/${saswat.id}/password`).send({ password: 'reset-by-rahul' })).status).toBe(204);

    expect((await saswatAgent.get(`${HQ}/auth/me`)).status).toBe(401);
    await loginAgent(app, 'saswat@example.com', 'reset-by-rahul');
  });

  test('keeps the current session when you set your own password', async () => {
    const otherDevice = await loginAgent(app, 'rahul@example.com');
    const res = await rahulAgent.post(`${HQ}/users/${rahul.id}/password`).send({ password: 'my-new-password' });
    expect(res.status).toBe(204);
    expect(sessionCookieHeader(res)).toBeTruthy();
    expect((await rahulAgent.get(`${HQ}/auth/me`)).status).toBe(200);
    expect((await otherDevice.get(`${HQ}/auth/me`)).status).toBe(401);
  });

  test('returns 404 for an unknown account and 422 for a short password', async () => {
    expect((await rahulAgent.post(`${HQ}/users/${MISSING_ID}/password`).send({ password: 'long-enough' })).status).toBe(404);
    expect((await rahulAgent.post(`${HQ}/users/${rahul.id}/password`).send({ password: 'short' })).status).toBe(422);
    await loginAgent(app, 'rahul@example.com', DEFAULT_PASSWORD); // unchanged
  });
});

describe('DELETE /hq/users/:id', () => {
  test('removes the seat (204): that person loses HQ access immediately but keeps their account', async () => {
    const saswat = await addSaswat();
    const saswatAgent = await loginAgent(app, 'saswat@example.com');
    expect((await rahulAgent.delete(`${HQ}/users/${saswat.id}`)).status).toBe(204);
    const after = await saswatAgent.get(`${HQ}/auth/me`);
    expect(after.status).toBe(403); // still signed in to Mariox One, but no seat
    expect(after.body.error.code).toBe('FORBIDDEN');
    expect((await rahulAgent.get(`${HQ}/users`)).body.data).toHaveLength(1);
    expect(await User.findOne({ email: 'saswat@example.com' }).rows()).toMatchObject({ status: 'Active', hq_seat: null });
    // The original seat id is free again for an older client that asks for it.
    expect((await rahulAgent.post(`${HQ}/users`).send({ name: 'New Co', email: 'newco@example.com', password: 'a-good-password', seat: 'saswat' })).body.data.seat).toBe('saswat');
  });

  test('returns 403 when removing your own account', async () => {
    const res = await rahulAgent.delete(`${HQ}/users/${rahul.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe("You can't remove your own account.");
  });

  test('returns 404 for an unknown account', async () => {
    expect((await rahulAgent.delete(`${HQ}/users/${MISSING_ID}`)).status).toBe(404);
  });
});
