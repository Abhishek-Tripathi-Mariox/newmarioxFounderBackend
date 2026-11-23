import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config/index.js';

const json = (message) => (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } });

/** General API limit per client IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Production: 600 requests/min per IP. Development: generous (each sign-in loads ~30 lists).
  limit: config.isProd ? 600 : 10_000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: json('Too many requests — slow down and try again in a minute'),
});

/** Brute-force protection for login: per IP + email. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isProd ? 10 : 1_000, // strict in production; relaxed for local dev and tests
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // ipKeyGenerator groups IPv6 addresses by /56 subnet so one client can't rotate addresses to dodge the limit.
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
  handler: json('Too many login attempts — try again in 15 minutes'),
});

const RESET_LIMIT_MSG = 'Too many password reset attempts — try again in 15 minutes';
const resetLimiter = (handler) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isProd ? 20 : 1_000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').trim().toLowerCase()}`,
  handler,
});

/**
 * Forgot password: per IP + email (IP alone for the last step), on top of the per-code rules
 * (60 s resend cooldown, 5 tries per code). Portal error shape for /auth/forgot*, the partner
 * app's `{ error }` for /pp/auth/forgot*.
 */
export const passwordResetLimiter = resetLimiter(json(RESET_LIMIT_MSG));
export const ppPasswordResetLimiter = resetLimiter((_req, res) => res.status(429).json({ error: RESET_LIMIT_MSG }));
