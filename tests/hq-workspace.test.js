import request from 'supertest';
import { HqWorkspaceRevision } from '../src/db/models/index.js';
import { REVISIONS_KEPT } from '../src/modules/hq/workspace/workspace.service.js';
import { closeDb, createTestUser, resetHqDb, HQ, loginAgent, makeApp } from './hq-helpers.js';

let app;
let rahul;
let saswat;
let rahulUser;

beforeEach(async () => {
  await resetHqDb();
  app = makeApp();
  rahulUser = await createTestUser({ name: 'Rahul Garg', email: 'rahul@example.com', seat: 'rahul' });
  await createTestUser({ name: 'Saswat', email: 'saswat@example.com', seat: 'saswat' });
  rahul = await loginAgent(app, 'rahul@example.com');
  saswat = await loginAgent(app, 'saswat@example.com');
});
afterAll(closeDb);

test('requires a session (401)', async () => {
  expect((await request(app).get(`${HQ}/workspace`)).status).toBe(401);
  expect((await request(app).put(`${HQ}/workspace`).send({ data: {}, baseVersion: 0 })).status).toBe(401);
  expect((await request(app).get(`${HQ}/workspace/prefs`)).status).toBe(401);
  expect((await request(app).put(`${HQ}/workspace/prefs`).send({ prefs: {} })).status).toBe(401);
});

test('starts empty at version 0', async () => {
  const res = await rahul.get(`${HQ}/workspace`);
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ data: null, version: 0, updatedAt: null, updatedBy: null });
});

test('saves, bumps the version and shows who saved it', async () => {
  const data = { tasks: [{ id: 't1', title: 'Ship', done: false }], goals: [], fin: { runway: 12 }, empty: {} };
  const saved = await rahul.put(`${HQ}/workspace`).send({ data, baseVersion: 0 });
  expect(saved.status).toBe(200);
  expect(saved.body.data.version).toBe(1);
  expect(saved.body.data.updatedBy).toEqual({ id: rahulUser.id, name: 'Rahul Garg' });
  expect(Date.parse(saved.body.data.updatedAt)).toBeTruthy();

  const read = await saswat.get(`${HQ}/workspace`);
  expect(read.status).toBe(200);
  expect(read.body.data.data).toEqual(data);
  expect(read.body.data.version).toBe(1);
  expect(read.body.data.updatedBy).toEqual({ id: rahulUser.id, name: 'Rahul Garg' });

  const next = await saswat.put(`${HQ}/workspace`).send({ data: { tasks: [] }, baseVersion: 1 });
  expect(next.status).toBe(200);
  expect(next.body.data.version).toBe(2);
  expect(next.body.data.updatedBy.name).toBe('Saswat');
  // The whole object is replaced, not merged.
  expect((await rahul.get(`${HQ}/workspace`)).body.data.data).toEqual({ tasks: [] });
});

test('returns 409 with the newer copy when baseVersion is stale', async () => {
  expect((await rahul.put(`${HQ}/workspace`).send({ data: { v: 'rahul' }, baseVersion: 0 })).status).toBe(200);

  const res = await saswat.put(`${HQ}/workspace`).send({ data: { v: 'saswat' }, baseVersion: 0 });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('CONFLICT');
  const { details } = res.body.error;
  expect(details.version).toBe(1);
  expect(details.data).toEqual({ v: 'rahul' });
  expect(details.updatedBy.name).toBe('Rahul Garg');
  expect(Date.parse(details.updatedAt)).toBeTruthy();

  // A baseVersion from the future is a conflict too.
  expect((await saswat.put(`${HQ}/workspace`).send({ data: {}, baseVersion: 7 })).status).toBe(409);
  expect((await rahul.get(`${HQ}/workspace`)).body.data.data).toEqual({ v: 'rahul' });
});

test('lets exactly one of many concurrent saves win (first save)', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? rahul : saswat).put(`${HQ}/workspace`).send({ data: { writer: i }, baseVersion: 0 })),
  );
  expect(attempts.map((res) => res.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
  const winner = attempts.find((res) => res.status === 200);
  const stored = (await rahul.get(`${HQ}/workspace`)).body.data;
  expect(stored.version).toBe(1);
  expect(winner.body.data.version).toBe(1);
});

test('lets exactly one of many concurrent saves win (existing document)', async () => {
  expect((await rahul.put(`${HQ}/workspace`).send({ data: { writer: 'seed' }, baseVersion: 0 })).status).toBe(200);
  const attempts = await Promise.all(
    Array.from({ length: 10 }, (_, i) => (i % 2 ? rahul : saswat).put(`${HQ}/workspace`).send({ data: { writer: i }, baseVersion: 1 })),
  );
  const winners = attempts.filter((res) => res.status === 200);
  expect(winners).toHaveLength(1);
  expect(attempts.filter((res) => res.status === 409)).toHaveLength(9);

  const stored = (await rahul.get(`${HQ}/workspace`)).body.data;
  expect(stored.version).toBe(2);
  expect(stored.data).toEqual({ writer: attempts.indexOf(winners[0]) });
});

test(`records a revision per save and keeps the last ${REVISIONS_KEPT}`, async () => {
  let version = 0;
  for (let i = 0; i < REVISIONS_KEPT + 5; i += 1) {
    const res = await rahul.put(`${HQ}/workspace`).send({ data: { i }, baseVersion: version });
    expect(res.status).toBe(200);
    version = res.body.data.version;
  }
  const revisions = await HqWorkspaceRevision.find().sort({ version: 1 }).lean();
  expect(revisions).toHaveLength(REVISIONS_KEPT);
  expect(revisions[0].version).toBe(6);
  expect(revisions.at(-1).version).toBe(REVISIONS_KEPT + 5);
  expect(String(revisions.at(-1).by)).toBe(rahulUser.id);
  expect(revisions.at(-1).at).toBeInstanceOf(Date);
}, 60000);

test('validates the body (422)', async () => {
  const notObject = await rahul.put(`${HQ}/workspace`).send({ data: [1, 2], baseVersion: 0 });
  expect(notObject.status).toBe(422);
  expect(notObject.body.error.details[0].path).toBe('body.data');
  expect((await rahul.put(`${HQ}/workspace`).send({ data: {}, baseVersion: -1 })).status).toBe(422);
  expect((await rahul.put(`${HQ}/workspace`).send({ data: {}, baseVersion: 1.5 })).status).toBe(422);
  expect((await rahul.put(`${HQ}/workspace`).send({ data: {} })).status).toBe(422);
});

test('stores the shared document in hq_workspaces', async () => {
  expect((await rahul.put(`${HQ}/workspace`).send({ data: { a: 1 }, baseVersion: 0 })).status).toBe(200);
  const { HqWorkspace } = await import('../src/db/models/index.js');
  expect(HqWorkspace.collection.collectionName).toBe('hq_workspaces');
  expect(await HqWorkspace.countDocuments()).toBe(1);
});

describe('prefs', () => {
  test('defaults to {} and is stored per user', async () => {
    const empty = await rahul.get(`${HQ}/workspace/prefs`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ data: {} });

    const prefs = { theme: 'dark', sidebar: { collapsed: true }, pinned: [] };
    const saved = await rahul.put(`${HQ}/workspace/prefs`).send({ prefs });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual(prefs);
    expect((await rahul.get(`${HQ}/workspace/prefs`)).body.data).toEqual(prefs);
    expect((await saswat.get(`${HQ}/workspace/prefs`)).body.data).toEqual({});
  });

  test('validates prefs (422), including the 64 KB cap', async () => {
    expect((await rahul.put(`${HQ}/workspace/prefs`).send({ prefs: 'dark' })).status).toBe(422);
    expect((await rahul.put(`${HQ}/workspace/prefs`).send({})).status).toBe(422);
    const tooBig = await rahul.put(`${HQ}/workspace/prefs`).send({ prefs: { blob: 'x'.repeat(64 * 1024) } });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.message).toBe('Preferences are too large (64 KB max).');
  });
});
