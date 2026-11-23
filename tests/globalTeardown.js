import 'dotenv/config';
import mongoose from 'mongoose';

/** Safety net: drop this run's test database even when a test file crashed before closeDb(). */
export default async function globalTeardown() {
  const name = process.env.MARIOXONE_TEST_DB;
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri || !name || !name.startsWith('marioxone_test_')) return;
  const conn = await mongoose.createConnection(uri, { dbName: name }).asPromise();
  try {
    await conn.dropDatabase();
  } finally {
    await conn.close();
  }
}
