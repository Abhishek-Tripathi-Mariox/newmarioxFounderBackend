import { resolveSession } from '../../../middleware/authenticate.js';
import { ensureSeatRecord } from '../users/users.service.js';
import { forbidden, unauthorized } from './errors.js';

/**
 * Founders HQ access (docs/SSO.md): the person signed in to Mariox One (portal `mx_refresh` session
 * cookie, or a Bearer access token) who is an HQ member (`users.hq_seat`, any number of founders / co-founders). Everything is re-read on
 * every request, so sign-out, deactivation and a removed seat take effect immediately.
 * Sets `req.actor` (the portal principal) and `req.hqUser` (their hq_users record).
 */
export async function authenticateHq(req, _res, next) {
  const { principal, reason } = await resolveSession(req);
  if (!principal) throw unauthorized(reason === 'none' ? 'Please sign in to continue.' : 'Your session has ended. Please sign in again.');
  if (!principal.hqSeat) throw forbidden('Founders HQ is only open to founders and co-founders.');
  req.actor = principal;
  req.hqUser = await ensureSeatRecord(principal);
  next();
}

/** Managing the HQ accounts creates and changes Super Admins, so it needs a Super Admin. */
export function requireSuperAdmin(req, _res, next) {
  if (!req.actor.isSuper) throw forbidden('Only a Super Admin can manage Founders HQ accounts.');
  next();
}
