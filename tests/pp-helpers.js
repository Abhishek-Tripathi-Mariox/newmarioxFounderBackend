/**
 * Fixture for the partner-portal tests (/api/v1/pp). `ppReset()` empties the test database, seeds the
 * base roles and creates (password for everyone: "Partner@123"), each a Mariox One account linked to
 * its Mariox Partners profile (docs/SSO.md):
 *   admin@pp.io    Super Admin u-ppadmin → partner-admin profile
 *   rohit@pp.io    partner u-rohit, MX-P-243-1, rate 0.5
 *   sana@pp.io     partner u-sana,  MX-P-243-2, rate 0.4
 *   gone@pp.io     partner u-gone,  MX-P-243-3, disabled (account Deactivated)
 * Returns the profile ids. `ppAgent(email)` signs in at the portal login and returns a supertest agent
 * that keeps the mx_refresh session cookie.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { PpUser, User } from '../src/db/models/index.js';
import { seedBase } from '../src/db/seed/base.js';
import { app, emptyTestDb } from './helpers.js';

export const PP = '/api/v1/pp';
export const LOGIN = '/api/v1/auth/login';
export const PP_PASSWORD = 'Partner@123';

/** A partner profile plus its portal account (role Partner), like an accepted invite. */
export async function addPartner({ userId, status = 'active', password = PP_PASSWORD, ...profile }) {
  const doc = await PpUser.create({ role: 'partner', status, ...profile });
  const accountStatus = { active: 'Active', invited: 'Invited', disabled: 'Deactivated' }[status];
  await User.insertMany([{
    id: userId, name: doc.name, email: doc.email, role_id: 'r-partner', status: accountStatus,
    password_hash: password ? await bcrypt.hash(password, 4) : null, pp_user_id: String(doc._id),
  }]);
  return String(doc._id);
}

export async function ppReset() {
  await emptyTestDb();
  await seedBase();
  const admin = await PpUser.create({ name: 'Mariox Admin', email: 'admin@pp.io', role: 'admin', status: 'active', source: 'seed' });
  await User.insertMany([{
    id: 'u-ppadmin', name: 'Mariox Admin', email: 'admin@pp.io', role_id: 'r-super', status: 'Active',
    password_hash: await bcrypt.hash(PP_PASSWORD, 4), pp_user_id: String(admin._id),
  }]);
  const rohit = await addPartner({ userId: 'u-rohit', name: 'Rohit Sharma', email: 'rohit@pp.io', partnerCode: 'MX-P-243-1', company: 'Sharma Digital', commissionRate: 0.5, source: 'seed' });
  const sana = await addPartner({ userId: 'u-sana', name: 'Sana Khan', email: 'sana@pp.io', partnerCode: 'MX-P-243-2', company: 'Khan Ventures', commissionRate: 0.4, source: 'admin' });
  const gone = await addPartner({ userId: 'u-gone', name: 'Gone Partner', email: 'gone@pp.io', partnerCode: 'MX-P-243-3', status: 'disabled', source: 'admin' });
  return { admin: String(admin._id), rohit, sana, gone };
}

/** Sign in with the one Mariox One login; the agent then carries the session cookie to /pp. */
export async function ppAgent(email, password = PP_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(LOGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** YYYY-MM-DD `n` days from today in IST (the portal's "not in the past" rules use IST). */
export const istDay = (n = 0) => new Date(Date.now() + 5.5 * 36e5 + n * 864e5).toISOString().slice(0, 10);
