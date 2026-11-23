import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../../../core/errors.js';
import { badRequest, conflict, notFound, payloadTooLarge, validationError } from './errors.js';

const DUPLICATE_KEY_MESSAGES = {
  email: 'An account with this email already exists.',
  seat: 'That seat is already taken.',
};

/**
 * HQ-level error translator, mounted at the end of the /hq router. It turns the errors the HQ
 * produces into the answers the original HQ backend gave (messages the HQ frontend shows), then
 * hands an AppError to the app's central error handler, which renders the shared envelope.
 */
export function hqErrorTranslator(error, _req, _res, next) {
  if (error instanceof AppError) return next(error);
  if (error instanceof ZodError) return next(validationError(error.issues));
  if (error?.type === 'entity.too.large') return next(payloadTooLarge('That request is too large.'));
  if (error?.type === 'entity.parse.failed') return next(badRequest('The request body is not valid JSON.'));
  if (error instanceof mongoose.Error.CastError) return next(badRequest(`The value for "${error.path}" is not valid.`));
  if (error instanceof mongoose.Error.ValidationError) {
    return next(validationError(Object.values(error.errors).map((item) => ({ path: [item.path], message: item.message, code: item.kind }))));
  }
  if (error?.code === 11000) {
    const field = Object.keys(error.keyValue ?? error.keyPattern ?? {})[0];
    return next(conflict(DUPLICATE_KEY_MESSAGES[field] ?? 'That already exists.'));
  }
  return next(error);
}

/** Unknown /hq route: NOT_FOUND in the HQ's wording. */
export function hqNotFound(req, _res, next) {
  next(notFound(`There is no ${req.method} ${req.originalUrl.split('?')[0]} endpoint.`));
}
