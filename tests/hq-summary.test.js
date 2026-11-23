import request from 'supertest';
import { createSummaryService, DEFAULT_SUMMARY_SOURCES, replaceSummaryService } from '../src/modules/hq/summary/summary.service.js';
import { marioxSummary } from '../src/modules/founder/founder.service.js';
import { closeDb, createTestUser, resetHqDb, HQ, loginAgent, makeApp } from './hq-helpers.js';
import { resetDb } from './helpers.js';

/** In-process fake of both summary builders, recording every call. */
function fakeSources() {
  const calls = [];
  const behaviour = { mariox: 'ok', partners: 'ok', delayMs: 0 };
  const builder = (name, payload) => async (now) => {
    calls.push({ name, now });
    if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
    if (behaviour[name] === 'fail') throw new Error(`${name} exploded`);
    return payload;
  };
  const sources = {
    mariox: { label: 'Mariox internal portal', load: async () => builder('mariox', { product: 'portal', clients: 12 }) },
    partners: { label: 'Mariox partners app', load: async () => builder('partners', { product: 'partners', partners: 3 }) },
  };
  return { sources, calls, behaviour };
}

let app;
let agent;
let fake;
let restore;

const useService = (options = {}) => {
  const previous = replaceSummaryService(createSummaryService({ sources: fake.sources, timeoutMs: 1000, cacheTtlMs: 60_000, ...options }));
  restore ??= previous;
};

beforeEach(async () => {
  await resetHqDb();
  app = makeApp();
  fake = fakeSources();
  useService();
  await createTestUser({ email: 'rahul@example.com' });
  agent = await loginAgent(app, 'rahul@example.com');
});
afterEach(() => replaceSummaryService(restore));
afterAll(closeDb);

test('requires a session (401)', async () => {
  expect((await request(app).get(`${HQ}/summary/mariox`)).status).toBe(401);
  expect((await request(app).get(`${HQ}/summary/partners`)).status).toBe(401);
});

test('returns both summaries in the { data } envelope', async () => {
  const mariox = await agent.get(`${HQ}/summary/mariox`);
  expect(mariox.status).toBe(200);
  expect(mariox.body).toEqual({ data: { product: 'portal', clients: 12 } });

  const partners = await agent.get(`${HQ}/summary/partners`);
  expect(partners.status).toBe(200);
  expect(partners.body).toEqual({ data: { product: 'partners', partners: 3 } });

  expect(fake.calls.map((call) => call.name)).toEqual(['mariox', 'partners']);
  expect(typeof fake.calls[0].now).toBe('number');
});

test('caches each source for the TTL and shares concurrent computations', async () => {
  await Promise.all([agent.get(`${HQ}/summary/mariox`), agent.get(`${HQ}/summary/mariox`)]);
  expect((await agent.get(`${HQ}/summary/mariox`)).status).toBe(200);
  expect(fake.calls).toHaveLength(1);

  expect((await agent.get(`${HQ}/summary/partners`)).status).toBe(200);
  expect(fake.calls).toHaveLength(2); // each source has its own cache entry
});

test('computes again once the cache has expired', async () => {
  useService({ cacheTtlMs: 1 });
  expect((await agent.get(`${HQ}/summary/mariox`)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await agent.get(`${HQ}/summary/mariox`)).status).toBe(200);
  expect(fake.calls).toHaveLength(2);
});

test('one part failing: 502 UPSTREAM_ERROR for it, the other still answers, failures are not cached', async () => {
  fake.behaviour.mariox = 'fail';
  const failed = await agent.get(`${HQ}/summary/mariox`);
  expect(failed.status).toBe(502);
  expect(failed.body.error.code).toBe('UPSTREAM_ERROR');
  expect(failed.body.error.message).toBe('The Mariox internal portal is not responding right now. Please try again shortly.');
  expect(failed.body.error.message).not.toContain('exploded'); // internals stay in the logs

  expect((await agent.get(`${HQ}/summary/partners`)).status).toBe(200);

  fake.behaviour.mariox = 'ok';
  expect((await agent.get(`${HQ}/summary/mariox`)).status).toBe(200);
  expect(fake.calls.filter((call) => call.name === 'mariox')).toHaveLength(2);
});

test('returns 502 when a summary takes longer than the timeout', async () => {
  useService({ timeoutMs: 50 });
  fake.behaviour.delayMs = 300;
  const res = await agent.get(`${HQ}/summary/partners`);
  expect(res.status).toBe(502);
  expect(res.body.error.code).toBe('UPSTREAM_ERROR');
});

test('returns 503 NOT_CONFIGURED when a source is not available in this server', async () => {
  const missingModule = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
  useService({ sources: { ...fake.sources, partners: { label: 'Mariox partners app', load: async () => { throw missingModule; } } } });
  const res = await agent.get(`${HQ}/summary/partners`);
  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe('NOT_CONFIGURED');
  expect(res.body.error.message).toBe('The Mariox partners app summary is not set up on this server yet.');
  expect((await agent.get(`${HQ}/summary/mariox`)).status).toBe(200);
});

test('the default mariox source is the founder module’s marioxSummary (in-process, no HTTP)', async () => {
  expect(await DEFAULT_SUMMARY_SOURCES.mariox.load()).toBe(marioxSummary);
});

test('GET /hq/summary/mariox returns exactly what the founder module builds (portal fixture data)', async () => {
  await resetDb();
  await createTestUser({ email: 'rahul@example.com' });
  const signedIn = await loginAgent(app, 'rahul@example.com');
  const FIXED_NOW = Date.now();
  useService({ sources: DEFAULT_SUMMARY_SOURCES, now: () => FIXED_NOW });

  const res = await signedIn.get(`${HQ}/summary/mariox`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: JSON.parse(JSON.stringify(await marioxSummary(FIXED_NOW))) });
});
