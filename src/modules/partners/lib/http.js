import mongoose from 'mongoose';
import multer from 'multer';
import { ZodError } from 'zod';
import { logger } from '../../../core/logger.js';

/**
 * HTTP conventions of the partner portal API (ported from mariox-saas src/lib/api.ts). Unlike the rest
 * of the backend, responses are the bare payload (`{ user }`, `{ leads, meta }`) and errors are
 * `{ error: "message" }` — exactly what the Next.js app returned, so frontend/src/partners works unchanged.
 */

/** An expected failure with the HTTP status and the message shown to the user. */
export class PpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PpError';
    this.status = status;
  }
}

/**
 * Validate a JSON request body with a zod schema (the source's `body(req, schema)`).
 * A missing body is "Body must be JSON"; a zod failure becomes a 400 in `ppErrorHandler`.
 */
export function parseBody(req, schema) {
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') throw new PpError(400, 'Body must be JSON');
  return schema.parse(req.body);
}

/** The request's query string as URLSearchParams (repeated keys and commas kept as sent). */
export const searchParams = (req) => new URL(req.originalUrl, 'http://localhost').searchParams;

/** Unknown /pp paths answer in the portal's error shape instead of falling through to the internal API. */
export function ppNotFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

/** Error middleware for the /pp router: the same status codes and messages as the source's `handle()`. */
export function ppErrorHandler(err, req, res, _next) {
  if (err instanceof PpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path?.join('.');
    const msg = first ? `${path ? `${path}: ` : ''}${first.message}` : 'Invalid input';
    return res.status(400).json({ error: msg, issues: err.issues });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body must be JSON' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_COUNT' ? 'Up to 10 files at a time' : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err?.code === 11000) return res.status(409).json({ error: 'Already exists' });
  if (err instanceof mongoose.Error.CastError || err?.name === 'CastError') return res.status(404).json({ error: 'Not found' });
  if (err?.name === 'MongooseServerSelectionError') {
    logger.error({ err, requestId: req.id }, 'Partner portal: database unreachable');
    return res.status(503).json({ error: `Database unreachable: ${err.message}.` });
  }
  logger.error({ err, requestId: req.id }, 'Partner portal: unhandled error');
  return res.status(500).json({ error: 'Server error' });
}
