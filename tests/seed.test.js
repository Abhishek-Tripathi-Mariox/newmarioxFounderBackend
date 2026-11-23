/**
 * Seeds: base (roles, masters, settings) and superAdmin (the only starting account).
 * Each test starts from an emptied test database with only the base seed.
 */
import bcrypt from 'bcryptjs';
import { Role, User } from '../src/db/models/index.js';
import { seedBase, ROLES } from '../src/db/seed/base.js';
import { createSuperAdmin } from '../src/db/seed/superAdmin.js';
import { closeDb, emptyTestDb } from './helpers.js';

const quiet = () => {};

beforeEach(async () => {
  await emptyTestDb();
  await seedBase();
});
afterAll(closeDb);

test('base seed loads every role', async () => {
  expect(await Role.countDocuments()).toBeGreaterThanOrEqual(ROLES.length);
});

test('creates one active Super Admin with the configured password, and is idempotent', async () => {
  const r = await createSuperAdmin({ email: ' Boss@Example.com ', password: 'StrongPass1', name: 'Boss', rounds: 4, log: quiet });
  expect(r.created).toBe(true);
  expect(r.user).toMatchObject({ email: 'boss@example.com', name: 'Boss', role_id: 'r-super', status: 'Active' });
  expect(await bcrypt.compare('StrongPass1', r.user.password_hash)).toBe(true);

  const again = await createSuperAdmin({ email: 'other@example.com', password: 'Different1', rounds: 4, log: quiet });
  expect(again.created).toBe(false);
  expect(await User.countDocuments()).toBe(1);
  expect(await bcrypt.compare('StrongPass1', (await User.findOne().rows()).password_hash)).toBe(true);
});

test('generates a password when none is set; rejects bad input', async () => {
  const r = await createSuperAdmin({ email: 'a@b.co', password: '', rounds: 4, log: quiet });
  expect(r.password).toHaveLength(16);
  expect(await bcrypt.compare(r.password, r.user.password_hash)).toBe(true);
  await expect(createSuperAdmin({ email: 'not-an-email', password: 'x'.repeat(10), log: quiet })).rejects.toThrow(/SUPER_ADMIN_EMAIL/);
  await expect(createSuperAdmin({ email: 'c@d.co', password: 'short', log: quiet })).rejects.toThrow(/8 characters/);
});
