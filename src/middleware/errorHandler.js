import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { config } from '../config/index.js';

/** 404 for unknown routes (mounted after all routers). */
export function notFoundRoute(req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.id } });
}

/** Index name of a duplicate-key error (the old Postgres constraint name), e.g. "email_1". */
const duplicateIndex = (err) => /index: (\S+)/.exec(err.message || '')?.[1];

/**
 * Map database errors to client errors where the cause is the request, not the server — the same
 * answers the API gave for the Postgres unique / check / malformed-value errors.
 */
function fromDb(err) {
  if (err.code === 11000) return new AppError(409, 'CONFLICT', 'A record with these details already exists', { constraint: duplicateIndex(err) });
  if (err instanceof mongoose.Error.ValidationError) {
    const failed = Object.values(err.errors);
    if (failed.some((e) => e instanceof mongoose.Error.CastError)) return new AppError(400, 'BAD_REQUEST', 'Malformed value in request');
    return new AppError(422, 'CHECK_VIOLATION', 'A value is out of the allowed range', { constraint: failed.map((e) => e.path).join(',') });
  }
  if (err instanceof mongoose.Error.CastError) return new AppError(400, 'BAD_REQUEST', 'Malformed value in request');
  return null;
}

/** Central error handler: one JSON error shape, no stack traces leaked outside development. */
export function errorHandler(err, req, res, _next) {
  let e = err;
  if (!(e instanceof AppError)) {
    if (e instanceof multer.MulterError) {
      e = new AppError(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', e.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${Math.round(config.uploads.maxBytes / 1048576)} MB` : e.message);
    } else if (e.type === 'entity.parse.failed') {
      e = new AppError(400, 'BAD_JSON', 'Request body is not valid JSON');
    } else if (e.type === 'entity.too.large') {
      e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else {
      e = fromDb(e) || e;
    }
  }

  if (e instanceof AppError) {
    if (e.status >= 500) logger.error({ err, requestId: req.id }, e.message);
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: req.id } });
  }

  logger.error({ err, requestId: req.id }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side', requestId: req.id, ...(config.env === 'development' ? { debug: String(err.stack || err) } : {}) },
  });
}
