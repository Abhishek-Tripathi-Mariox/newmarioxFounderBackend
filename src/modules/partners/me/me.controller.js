import { sessionMeta, setRefreshCookie } from '../../../core/tokens.js';
import { parseBody } from '../lib/http.js';
import * as s from './me.schemas.js';
import * as svc from './me.service.js';

/**
 * Own profile plus `apps` (which Mariox One areas the person can open, for the app switcher) and, for
 * admins, `perms`: what their role may do per admin section ({ pp_acq: { v, c, e, d }, … }).
 */
export const get = async (req, res) => res.json({ user: { ...(await svc.get(req.pp)), apps: req.pp.apps, perms: req.pp.perms } });
export const update = async (req, res) => res.json({ user: await svc.updateProfile(req.pp, parseBody(req, s.profileSchema)) });

export async function changePassword(req, res) {
  const session = await svc.changePassword(req.pp, parseBody(req, s.passwordSchema), sessionMeta(req));
  setRefreshCookie(res, session.refreshToken);
  res.json({ ok: true });
}

export async function revokeSessions(req, res) {
  await svc.revokeOtherSessions(req.pp);
  res.json({ ok: true });
}
