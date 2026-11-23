/**
 * Helpers for the Founders HQ suites (tests/hq-*.test.js). They use the shared harness database
 * (tests/helpers.js) and build a fresh app per test. HQ accounts are Mariox One users holding a seat
 * (docs/SSO.md), signed in through the portal login.
 */
import request from 'supertest';
import { createApp } from '../src/app.js';
import { seedBase } from '../src/db/seed/base.js';
import { createUser } from '../src/modules/hq/users/users.service.js';
import { emptyTestDb } from './helpers.js';

export { closeDb, emptyTestDb } from './helpers.js';

export const HQ = '/api/v1/hq';
export const LOGIN = '/api/v1/auth/login';
export const DEFAULT_PASSWORD = 'correct-horse-battery';

export const makeApp = () => createApp();

/** Empty test database with the base roles (HQ accounts are Super Admins). */
export async function resetHqDb() {
  await emptyTestDb();
  await seedBase();
}

/** Create an HQ account (Super Admin + seat) directly through the service; returns its DTO. */
export function createTestUser({ name = 'Rahul Garg', email = 'rahul@example.com', password = DEFAULT_PASSWORD, seat } = {}) {
  return createUser({}, { name, email, password, seat });
}

/**
 * Sign in at the portal login and return a supertest agent that carries the mx_refresh session cookie.
 * @returns {Promise<import('supertest').Agent>}
 */
export async function loginAgent(app, email, password = DEFAULT_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(LOGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** The raw `mx_refresh` Set-Cookie header of a response. */
export function sessionCookieHeader(res) {
  return (res.headers['set-cookie'] ?? []).find((cookie) => cookie.startsWith('mx_refresh='));
}
