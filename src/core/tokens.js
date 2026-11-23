import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/** Short-lived JWT access token (sent as Authorization: Bearer). */
export const signAccessToken = (user) => jwt.sign({ sub: user.id, role: user.role_id || (user.role && user.role.id) }, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });

/** Opaque refresh token (random) + its sha256 for storage; rotated on every refresh. */
export function newRefreshToken() {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token), expiresAt: new Date(Date.now() + config.jwt.refreshTtlDays * 864e5) };
}
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');

/**
 * The one session of Mariox One: an httpOnly refresh-token cookie. Its path is the whole API so the
 * partner (/api/v1/pp) and Founders HQ (/api/v1/hq) routes receive it too (docs/SSO.md).
 */
export const REFRESH_COOKIE = 'mx_refresh';
export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax',
  path: '/api/v1',
  maxAge: config.jwt.refreshTtlDays * 864e5,
});

/** Set the refresh cookie (the raw token never goes in a response body). */
export const setRefreshCookie = (res, token) => res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());

/** Clear the refresh cookie (same options as when it was set, without maxAge). */
export function clearRefreshCookie(res) {
  const { maxAge, ...options } = refreshCookieOptions();
  void maxAge;
  res.clearCookie(REFRESH_COOKIE, options);
}

/** Device details stored with a refresh token. */
export const sessionMeta = (req) => ({ userAgent: (req.get('user-agent') || '').slice(0, 300), ip: req.ip });
