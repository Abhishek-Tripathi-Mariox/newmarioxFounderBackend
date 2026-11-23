/**
 * Founders HQ error factories. They build the shared AppError (rendered as
 * `{ error: { code, message, details?, requestId } }`) with the HQ's own plain-language messages,
 * which the HQ frontend shows as-is.
 */
import { AppError } from '../../../core/errors.js';

export const badRequest = (message = 'The request could not be understood.', details) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'We could not find what you were looking for.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
export const payloadTooLarge = (message = 'That request is too large.') => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
export const tooManyRequests = (message = 'Too many requests. Please wait a moment and try again.') => new AppError(429, 'TOO_MANY_REQUESTS', message);
export const upstreamError = (message = 'The upstream service is not responding right now.', details) => new AppError(502, 'UPSTREAM_ERROR', message, details);
export const notConfigured = (message = 'This feature is not set up on the server yet.') => new AppError(503, 'NOT_CONFIGURED', message);

/**
 * Turn Zod-style issues into a 422. The first issue's message is the headline (schema messages are
 * written for people); `details` keeps every issue for form highlighting.
 * @param {Array<{ path: PropertyKey[], message: string, code?: string }>} issues
 */
export function validationError(issues) {
  const details = issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message, code: issue.code }));
  return new AppError(422, 'VALIDATION_ERROR', details[0]?.message ?? 'Some of the information you sent is not valid.', details);
}
