import 'dotenv/config';

const base = {
  client: 'pg',
  migrations: { directory: './src/db/migrations', tableName: 'knex_migrations', loadExtensions: ['.js'] },
  pool: { min: 0, max: Number(process.env.DB_POOL_MAX || 10) },
};

/** LEGACY Knex CLI config (Postgres migrations), kept only until the MongoDB port is finished — see docs/MONGO.md. */
export default {
  development: { ...base, connection: process.env.DATABASE_URL },
  test: { ...base, connection: process.env.TEST_DATABASE_URL },
  production: { ...base, connection: process.env.DATABASE_URL },
};
