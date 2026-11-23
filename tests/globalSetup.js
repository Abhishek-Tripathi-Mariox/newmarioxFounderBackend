import { randomBytes } from 'node:crypto';

/** One throwaway test database name per jest run (read by tests/helpers.js; dropped in globalTeardown). */
export default function globalSetup() {
  process.env.MARIOXONE_TEST_DB = `marioxone_test_${randomBytes(6).toString('hex')}`;
}
