/**
 * Founders HQ with any number of Founders and Co-founders (docs/SSO.md "Founders HQ members"):
 * `users.hq_seat` is the member's HQ person id (unique), `users.hq_role` their role. The two
 * original seats ('rahul', 'saswat') keep their ids, so existing workspace data stays valid.
 */
import request from 'supertest';
import { HqUser, User } from '../src/db/models/index.js';
import { app, as, clearTokens, closeDb, PASSWORD, resetDb } from './helpers.js';

const API = '/api/v1';
const HQ = `${API}/hq`;

async function signIn(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(`${API}/auth/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.data.user };
}

/** A new HQ account created from the HQ Accounts dialog (as the CEO). */
const addMember = (ceo, name, email, role) => ceo.post(`${HQ}/users`).send({ name, email, password: 'a-good-password', ...(role ? { role } : {}) });

beforeEach(async () => {
  await resetDb();
  clearTokens();
  // An existing install: the CEO holds the original Founder seat, stored before roles existed (no hq_role).
  await User.collection.updateOne({ _id: 'u-ceo' }, { $set: { hq_seat: 'rahul' }, $unset: { hq_role: '' } });
});
afterAll(closeDb);

describe('several founders and co-founders', () => {
  test('the HQ Accounts dialog adds any number of each; each signs in to the HQ with their own person id', async () => {
    const { agent: ceo } = await signIn('ceo@test.io');
    const created = [];
    for (const [name, email, role] of [
      ['Founder Two', 'f2@test.io', 'founder'], ['Founder Three', 'f3@test.io', 'founder'],
      ['Co One', 'c1@test.io', 'cofounder'], ['Co Two', 'c2@test.io', undefined],
    ]) {
      const res = await addMember(ceo, name, email, role);
      expect(res.status).toBe(201);
      created.push(res.body.data);
    }
    expect(created.map((m) => m.role)).toEqual(['founder', 'founder', 'cofounder', 'cofounder']);
    const ids = created.map((m) => m.seat);
    expect(new Set([...ids, 'rahul']).size).toBe(5); // all different
    for (const m of created) expect(m.seat).toBe(m.userId); // derived from the user id

    // Listing: founders first (the original seat first), then co-founders, in the order they joined.
    const list = (await ceo.get(`${HQ}/users`)).body.data;
    expect(list.map((m) => [m.email, m.role, m.seatLabel])).toEqual([
      ['ceo@test.io', 'founder', 'Founder'], ['f2@test.io', 'founder', 'Founder'], ['f3@test.io', 'founder', 'Founder'],
      ['c1@test.io', 'cofounder', 'Co-founder'], ['c2@test.io', 'cofounder', 'Co-founder'],
    ]);
    expect(await User.findOne({ email: 'f2@test.io' }).rows()).toMatchObject({ role_id: 'r-super', title: 'Founder', hq_role: 'founder' });
    expect(await User.findOne({ email: 'c1@test.io' }).rows()).toMatchObject({ title: 'Co-founder', hq_role: 'cofounder' });

    // Each one lands in the HQ, as themselves, and shares the one workspace.
    const saved = await ceo.put(`${HQ}/workspace`).send({ data: { tasks: [{ id: 't1', owner: 'both' }] }, baseVersion: 0 });
    expect(saved.status).toBe(200);
    for (const m of created) {
      const { agent, user } = await signIn(m.email, 'a-good-password');
      expect(user).toMatchObject({ home: '/founders', apps: { founders: m.seat, foundersRole: m.role } });
      expect((await agent.get(`${HQ}/auth/me`)).body.data.user).toMatchObject({ seat: m.seat, role: m.role, email: m.email });
      expect((await agent.get(`${HQ}/workspace`)).body.data.data.tasks[0].owner).toBe('both');
      expect((await agent.get(`${HQ}/users`)).body.data).toHaveLength(5); // every member sees everyone (owner pickers)
    }

    // The legacy seat holder is normalised on read: Founder.
    const { user: ceoUser } = await signIn('ceo@test.io');
    expect(ceoUser.apps).toMatchObject({ founders: 'rahul', foundersRole: 'founder' });
  });

  test('change a member’s role, remove one (they lose access, keep the account) — but never yourself', async () => {
    const { agent: ceo } = await signIn('ceo@test.io');
    const co = (await addMember(ceo, 'Co One', 'c1@test.io')).body.data;
    const promoted = await ceo.patch(`${HQ}/users/${co.id}`).send({ role: 'founder' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data).toMatchObject({ role: 'founder', seatLabel: 'Founder', seat: co.seat }); // same person id
    expect((await ceo.patch(`${HQ}/users/${co.id}`).send({ role: 'ceo' })).status).toBe(422);

    const { agent: coAgent } = await signIn('c1@test.io', 'a-good-password');
    expect((await ceo.delete(`${HQ}/users/${co.id}`)).status).toBe(204);
    expect((await coAgent.get(`${HQ}/auth/me`)).status).toBe(403);
    expect(await User.findOne({ email: 'c1@test.io' }).rows()).toMatchObject({ status: 'Active', hq_seat: null, hq_role: null });
    expect((await ceo.get(`${HQ}/users`)).body.data.map((m) => m.email)).toEqual(['ceo@test.io']);

    const me = (await ceo.get(`${HQ}/users`)).body.data[0];
    expect((await ceo.delete(`${HQ}/users/${me.id}`)).status).toBe(403);
  });

  test('only a Super Admin manages HQ accounts', async () => {
    const { agent: ceo } = await signIn('ceo@test.io');
    const co = (await addMember(ceo, 'Co One', 'c1@test.io')).body.data;
    await User.updateOne({ email: 'c1@test.io' }, { role_id: 'r-admin' });
    const { agent: coAgent } = await signIn('c1@test.io', 'a-good-password');
    expect((await coAgent.get(`${HQ}/users`)).status).toBe(200); // still a member
    expect((await addMember(coAgent, 'X', 'x@test.io')).status).toBe(403);
    expect((await coAgent.patch(`${HQ}/users/${co.id}`).send({ role: 'founder' })).status).toBe(403);
  });
});

describe('Users & roles → Founders HQ access (None / Founder / Co-founder)', () => {
  test('a Super Admin grants Founder or Co-founder to several people; ids are stable and unique', async () => {
    const ceo = await as('ceo@test.io');
    const a = await ceo.patch(`${API}/users/u-admin`).send({ hq_role: 'founder' });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ hq_seat: 'u-admin', hq_role: 'founder' });
    const b = await ceo.patch(`${API}/users/u-mj`).send({ hq_role: 'founder' });
    expect(b.body.data).toMatchObject({ hq_seat: 'u-mj', hq_role: 'founder' });
    const c = await ceo.patch(`${API}/users/u-vg`).send({ hq_role: 'cofounder' });
    expect(c.body.data).toMatchObject({ hq_seat: 'u-vg', hq_role: 'cofounder' });
    const created = await ceo.post(`${API}/users`).send({
      name: 'Co Two', email: 'c2@test.io', role: 'r-super', dept: 'Management', sendInvite: false, password: 'secret123', hq_role: 'cofounder',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ hq_seat: created.body.data.id, hq_role: 'cofounder' });
    expect(created.body.data.ownerId).toBeTruthy(); // founders own leads

    // The legacy holder reads as Founder.
    expect((await ceo.get(`${API}/users/u-ceo`)).body.data).toMatchObject({ hq_seat: 'rahul', hq_role: 'founder' });

    // A role change keeps the person id; other edits keep both.
    expect((await ceo.patch(`${API}/users/u-admin`).send({ hq_role: 'cofounder' })).body.data).toMatchObject({ hq_seat: 'u-admin', hq_role: 'cofounder' });
    expect((await ceo.patch(`${API}/users/u-admin`).send({ title: 'COO' })).body.data).toMatchObject({ hq_seat: 'u-admin', hq_role: 'cofounder' });

    const { agent: dev, user } = await signIn('dev@test.io');
    expect(user.apps).toMatchObject({ founders: 'u-vg', foundersRole: 'cofounder' });
    expect((await dev.get(`${HQ}/users`)).body.data.map((m) => m.seat)).toEqual(['rahul', 'u-mj', 'u-admin', 'u-vg', created.body.data.id]);

    // Removing access (None) and giving it back returns the same person id (their HQ data is theirs again).
    expect((await ceo.patch(`${API}/users/u-vg`).send({ hq_role: null })).body.data).toMatchObject({ hq_seat: null, hq_role: null });
    expect((await dev.get(`${HQ}/auth/me`)).status).toBe(403);
    expect((await ceo.patch(`${API}/users/u-vg`).send({ hq_role: 'founder' })).body.data).toMatchObject({ hq_seat: 'u-vg', hq_role: 'founder' });
  });

  test('only a Super Admin; never clients; invalid values rejected', async () => {
    const admin = await as('admin@test.io');
    expect((await admin.patch(`${API}/users/u-mj`).send({ hq_role: 'founder' })).status).toBe(403);
    const ceo = await as('ceo@test.io');
    expect((await ceo.patch(`${API}/users/u-cl1`).send({ hq_role: 'cofounder' })).status).toBe(422);
    expect((await ceo.patch(`${API}/users/u-mj`).send({ hq_role: 'ceo' })).status).toBe(422);
    expect((await ceo.patch(`${API}/users/u-mj`).send({ hq_seat: 'u-mj' })).status).toBe(422); // only the original ids can be claimed
  });

  test('older clients: hq_seat claims an original seat, which stays unique', async () => {
    const ceo = await as('ceo@test.io');
    expect((await ceo.patch(`${API}/users/u-admin`).send({ hq_seat: 'rahul' })).body.error.message).toBe('The Founder seat is already taken by CEO.');
    const granted = await ceo.patch(`${API}/users/u-admin`).send({ hq_seat: 'saswat' });
    expect(granted.body.data).toMatchObject({ hq_seat: 'saswat', hq_role: 'cofounder' });
    expect((await ceo.patch(`${API}/users/u-mj`).send({ hq_seat: 'saswat' })).status).toBe(422);
  });

  test('the database keeps person ids unique and valid', async () => {
    await User.updateOne({ id: 'u-admin' }, { hq_seat: 'u-admin', hq_role: 'founder' });
    await expect(User.updateOne({ id: 'u-mj' }, { hq_seat: 'u-admin' })).rejects.toMatchObject({ code: 11000 });
    await expect(User.updateOne({ id: 'u-mj' }, { hq_seat: 'both' })).rejects.toThrow(/person id/);
    await expect(User.updateOne({ id: 'u-mj' }, { hq_seat: 'Has Spaces' })).rejects.toThrow(/person id/);
    await expect(User.updateOne({ id: 'u-mj' }, { hq_role: 'boss' })).rejects.toThrow();
  });
});

describe('existing data keeps working', () => {
  test('legacy seats without a stored role: rahul = Founder, saswat = Co-founder; their hq_users records keep their ids', async () => {
    await User.collection.updateOne({ _id: 'u-admin' }, { $set: { hq_seat: 'saswat' }, $unset: { hq_role: '' } });
    const { agent, user } = await signIn('admin@test.io');
    expect(user.apps).toMatchObject({ founders: 'saswat', foundersRole: 'cofounder' });
    const me = (await agent.get(`${HQ}/auth/me`)).body.data.user;
    expect(me).toMatchObject({ seat: 'saswat', role: 'cofounder', seatLabel: 'Co-founder' });
    expect(await HqUser.findOne({ seat: 'saswat' }).lean()).toMatchObject({ user_id: 'u-admin' });
    // Prefs are kept per person id.
    expect((await agent.put(`${HQ}/workspace/prefs`).send({ prefs: { theme: 'dark' } })).status).toBe(200);
    expect((await agent.get(`${HQ}/workspace/prefs`)).body.data).toEqual({ theme: 'dark' });
  });
});
