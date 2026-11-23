import request from 'supertest';
import { closeDb, emptyTestDb, HQ, makeApp } from './hq-helpers.js';

const app = makeApp();
beforeAll(emptyTestDb);
afterAll(closeDb);

test('reports ok without authentication', async () => {
  const res = await request(app).get(`${HQ}/health`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
  expect(res.body.db).toBe('up');
  expect(typeof res.body.uptime).toBe('number');
  expect(res.headers['x-request-id']).toBeTruthy();
});

test('returns 404 NOT_FOUND in the standard error shape for unknown HQ routes', async () => {
  const res = await request(app).get(`${HQ}/nope`);
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe('NOT_FOUND');
  expect(res.body.error.message).toBe('There is no GET /api/v1/hq/nope endpoint.');
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
});

test('reports degraded when the database is down', async () => {
  await closeDb();
  const res = await request(app).get(`${HQ}/health`);
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ status: 'degraded', db: 'down' });
});
