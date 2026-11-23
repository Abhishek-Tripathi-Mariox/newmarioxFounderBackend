import { clearRefreshCookie, REFRESH_COOKIE, sessionMeta, setRefreshCookie } from '../../../core/tokens.js';
import { AppError } from '../../../core/errors.js';
import { logout as endSession } from '../../auth/auth.service.js';
import * as reset from '../../auth/passwordReset.js';
import { PpError } from '../lib/http.js';
import { parseBody } from '../lib/http.js';
import * as s from './auth.schemas.js';
import * as svc from './auth.service.js';

/** Sign-out from the partner app = the one Mariox One sign-out (revokes this device's portal session). */
export async function logout(req, res) {
  await endSession(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  res.json({ ok: true });
}

/** Completing an invite signs the partner in to Mariox One (portal session cookie). */
export async function setPassword(req, res) {
  const { user, session } = await svc.setPassword(parseBody(req, s.setPasswordSchema), sessionMeta(req));
  if (session) setRefreshCookie(res, session.refreshToken);
  res.json({ user });
}

/** The portal's forgot-password service, answered in the partner app's `{ error }` shape. */
const asPp = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof AppError ? new PpError(e.status, e.message) : e;
  }
};

/** Forgot password = the one Mariox One flow (any account; same answers whether or not the email has one). */
export async function forgot(req, res) {
  const { email } = parseBody(req, s.forgotSchema);
  res.json(await asPp(() => reset.requestCode(email)));
}
export async function forgotVerify(req, res) {
  const { email, otp } = parseBody(req, s.forgotVerifySchema);
  res.json(await asPp(() => reset.verifyCode(email, otp)));
}
export async function forgotReset(req, res) {
  res.json(await asPp(() => reset.resetPassword(parseBody(req, s.forgotResetSchema))));
}
