import request from 'supertest';
import { HqVault } from '../src/db/models/index.js';
import { saveVaultBody } from '../src/modules/hq/vault/vault.schemas.js';
import { closeDb, createTestUser, resetHqDb, HQ, loginAgent, makeApp } from './hq-helpers.js';

const SEALED = { salt: 'c2FsdHNhbHRzYWx0', iv: 'aXZpdml2aXZpdg==', ct: 'Y2lwaGVydGV4dC1ibG9i+/==' };

let app;
let rahul;
let saswat;

beforeEach(async () => {
  await resetHqDb();
  app = makeApp();
  await createTestUser({ email: 'rahul@example.com', seat: 'rahul' });
  await createTestUser({ name: 'Saswat', email: 'saswat@example.com', seat: 'saswat' });
  rahul = await loginAgent(app, 'rahul@example.com');
  saswat = await loginAgent(app, 'saswat@example.com');
});
afterAll(closeDb);

test('requires a session (401)', async () => {
  expect((await request(app).get(`${HQ}/vault`)).status).toBe(401);
  expect((await request(app).put(`${HQ}/vault`).send(SEALED)).status).toBe(401);
});

test('returns null before anything is stored', async () => {
  const res = await rahul.get(`${HQ}/vault`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: null });
});

test('stores only the sealed blob (ciphertext) and shares it between founders', async () => {
  const saved = await rahul.put(`${HQ}/vault`).send({ ...SEALED, extra: 'ignored', passphrase: 'never-stored' });
  expect(saved.status).toBe(200);
  expect(saved.body.data).toEqual(SEALED);

  // Nothing but the sealed fields (and bookkeeping) is persisted.
  const stored = await HqVault.findOne().lean();
  expect(['_id', '__v', 'createdAt', 'ct', 'iv', 'key', 'salt', 'updatedAt', 'updatedBy']).toEqual(expect.arrayContaining(Object.keys(stored)));
  expect(JSON.stringify(stored)).not.toContain('never-stored');

  const read = await saswat.get(`${HQ}/vault`);
  expect(read.status).toBe(200);
  expect(read.body.data).toEqual(SEALED);

  const replaced = { ...SEALED, ct: 'bmV3ZXI=' };
  expect((await saswat.put(`${HQ}/vault`).send(replaced)).status).toBe(200);
  expect((await rahul.get(`${HQ}/vault`)).body.data).toEqual(replaced);
  expect(await HqVault.countDocuments()).toBe(1);
});

test('rejects missing or non-base64 fields (422)', async () => {
  const res = await rahul.put(`${HQ}/vault`).send({ salt: 'not base64!', iv: '' });
  expect(res.status).toBe(422);
  expect(res.body.error.details.map((detail) => detail.path).sort()).toEqual(['body.ct', 'body.iv', 'body.salt']);
});

test('accepts ct up to 2 MB and rejects anything larger', () => {
  const max = 'A'.repeat(2 * 1024 * 1024);
  expect(saveVaultBody.safeParse({ ...SEALED, ct: max }).success).toBe(true);
  const tooLarge = saveVaultBody.safeParse({ ...SEALED, ct: `${max}AAAA` });
  expect(tooLarge.success).toBe(false);
  expect(tooLarge.error.issues[0].message).toBe('ct is too large.');
});
