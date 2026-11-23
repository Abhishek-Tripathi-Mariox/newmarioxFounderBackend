/**
 * MongoDB connection (mongoose) and the transaction helper. Rules for repositories and services:
 * docs/MONGO.md.
 */
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import * as models from './models/index.js';

let transactionsEnabled = false;

/**
 * Connect the shared mongoose connection.
 * @param {object} [opts]
 * @param {string} [opts.uri=config.db.url]
 * @param {string} [opts.dbName] overrides the database named in the URI (the test harness uses this)
 */
export async function connectMongo({ uri = config.db.url, dbName } = {}) {
  await mongoose.connect(uri, { ...(dbName ? { dbName } : {}), autoIndex: false, maxPoolSize: config.db.poolMax });
  // Multi-document transactions need a replica set or a sharded cluster (Atlas is both).
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  transactionsEnabled = !!(hello.setName || hello.msg === 'isdbgrid');
  if (!transactionsEnabled) {
    logger.warn('MongoDB is a standalone server: transactions are OFF, multi-document writes are not atomic. Use a replica set (or Atlas) outside local development.');
  }
  return mongoose.connection;
}

export const disconnectMongo = () => mongoose.disconnect();

/** Build every model's indexes (idempotent; run at boot, by the seed script and by the test harness). */
export async function ensureIndexes() {
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
}

/** Readiness probe for /health. */
export async function pingMongo() {
  await mongoose.connection.db.admin().ping();
}

/**
 * Run `fn(session)` in a transaction: commits when it resolves, aborts when it throws.
 * Without transaction support (standalone dev server) `fn(null)` runs directly — writes are then
 * applied one by one, so services keep their checks before their writes.
 * @template T
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function tx(fn) {
  if (!transactionsEnabled) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}
