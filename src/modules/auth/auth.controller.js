import { ok, noContent } from '../../core/http.js';
import { REFRESH_COOKIE, clearRefreshCookie, sessionMeta as meta, setRefreshCookie } from '../../core/tokens.js';
import * as svc from './auth.service.js';
import * as reset from './passwordReset.js';

/** Set the httpOnly refresh cookie and return { accessToken, user } (the refresh token never goes in the body). */
function sendSession(res, { accessToken, refreshToken, user }) {
  setRefreshCookie(res, refreshToken);
  return ok(res, { accessToken, user });
}
const presented = (req) => req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;

export const login = async (req, res) => sendSession(res, await svc.login(req.body, meta(req)));

export async function refresh(req, res) {
  // No refresh cookie = simply not signed in (every signed-out page load asks). Answer 204 instead
  // of 401 so browsers don't log a console error; a present-but-invalid token is still a 401.
  if (!presented(req)) return noContent(res);
  try {
    return sendSession(res, await svc.refresh(presented(req), meta(req)));
  } catch (e) {
    clearRefreshCookie(res);
    throw e;
  }
}

export async function logout(req, res) {
  await svc.logout(presented(req));
  clearRefreshCookie(res);
  return noContent(res);
}

export const me = (req, res) => ok(res, { ...svc.principalDto(req.actor), previewing: !!req.previewing, viewAs: req.previewing ? svc.principalDto(req.user) : null });

export const changePassword = async (req, res) => sendSession(res, await svc.changePassword(req.actor.id, req.body, meta(req)));
export const acceptInvite = async (req, res) => sendSession(res, await svc.acceptInvite(req.body, meta(req)));
export async function resetPassword(req, res) {
  await svc.resetPassword(req.body);
  return noContent(res);
}

/** Forgot password: same answers whether or not the email has an account (passwordReset.js). */
export const forgot = async (req, res) => ok(res, await reset.requestCode(req.body.email));
export const forgotVerify = async (req, res) => ok(res, await reset.verifyCode(req.body.email, req.body.code));
export const forgotReset = async (req, res) => ok(res, await reset.resetPassword(req.body));
