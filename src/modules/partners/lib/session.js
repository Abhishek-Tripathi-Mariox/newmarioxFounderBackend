import { PpUser, User } from '../../../db/models/index.js';
import { resolveSession } from '../../../middleware/authenticate.js';
import { can } from '../../../middleware/authorize.js';
import { appsOf } from '../../auth/auth.service.js';
import { PpError } from './http.js';

/**
 * Who is using the partner portal (docs/SSO.md). There is no partner-portal login any more: the
 * person is the one signed in to Mariox One (the portal's `mx_refresh` session cookie, or a Bearer
 * access token), and their Mariox Partners identity is a `pp_users` profile linked by `users.pp_user_id`:
 *   - role Partner (`r-partner`) → their partner profile (must exist and not be disabled);
 *   - Super Admin or a role with the `pp` permission → their partner-admin profile, created and
 *     linked on first use. `pp.v` opens the admin side read-only, `pp.e` may change things.
 *
 * Sets `req.pp = { sub, role: 'admin'|'partner', name, canEdit, userId, tokenHash, apps }`: `sub` is the
 * pp_users id the services scope by, `userId` / `tokenHash` the portal account and this device's session,
 * `apps` the areas the person can open (same shape as the portal auth payload).
 *
 * 401 = no valid Mariox One session (the frontend sends people to /login); 403 = signed in without
 * access to this part of Mariox Partners (the frontend shows "no access").
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_ERRORS = {
  none: 'Not signed in',
  ended: 'Your session ended. Please sign in again.',
  inactive: 'Your account is suspended',
};

/** The partner profile of a partner account. */
async function partnerProfile(principal) {
  const profile = principal.ppUserId ? await PpUser.findById(principal.ppUserId).select('role status name').lean() : null;
  if (!profile || profile.role !== 'partner') throw new PpError(403, 'No partner profile is linked to this account');
  // Signed in, but no partner access: 403 (401 only means "no valid session").
  if (profile.status === 'disabled') throw new PpError(403, 'Your account is suspended');
  return profile;
}

/**
 * The partner-admin profile of an internal user: the linked one, else an admin profile with their
 * email (linked now), else a new one. A partner profile with that email is never taken over.
 */
async function adminProfile(principal) {
  if (principal.ppUserId) {
    const linked = await PpUser.findById(principal.ppUserId).select('role name').lean();
    if (linked?.role === 'admin') return linked;
    if (linked) throw new PpError(403, 'This account is linked to a partner profile');
  }
  const email = principal.email.trim().toLowerCase();
  const found = async () => PpUser.findOne({ email }).select('role name').lean();
  let profile = await found();
  if (!profile) {
    try {
      profile = (await PpUser.create({ name: principal.name, email, role: 'admin', status: 'active', source: 'portal' })).toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      profile = await found(); // created by a concurrent first request
    }
  }
  if (profile.role !== 'admin') throw new PpError(409, `${email} already belongs to a partner account`);
  await User.updateOne({ id: principal.id }, { pp_user_id: String(profile._id) });
  return profile;
}

/** Middleware: requires a portal session with access to Mariox Partners; sets `req.pp`. */
export async function requireSession(req, _res, next) {
  const { principal, tokenHash, reason } = await resolveSession(req);
  if (!principal) throw new PpError(401, SESSION_ERRORS[reason]);

  let pp;
  if (principal.isPartner) {
    const profile = await partnerProfile(principal);
    pp = { sub: String(profile._id), role: 'partner', name: profile.name, canEdit: true };
  } else {
    if (!can(principal, 'pp', 'v')) throw new PpError(403, 'Your role has no access to Mariox Partners');
    const profile = await adminProfile(principal);
    pp = { sub: String(profile._id), role: 'admin', name: profile.name, canEdit: can(principal, 'pp', 'e') };
  }
  // View-only partner admins can read everything but change only their own profile / password.
  if (!pp.canEdit && !SAFE_METHODS.has(req.method) && !req.baseUrl.endsWith('/me')) {
    throw new PpError(403, 'Your role can view Mariox Partners but not change it');
  }
  req.pp = { ...pp, userId: principal.id, tokenHash, apps: appsOf(principal) };
  next();
}

/** Middleware (after requireSession): partner-portal admins only. */
export function requireAdmin(req, _res, next) {
  if (req.pp?.role !== 'admin') throw new PpError(403, 'Admins only');
  next();
}

/** Partners only ever see their own records; admins see everything. */
export const scope = (s) => (s.role === 'admin' ? {} : { owner: s.sub });

/** Admins can act for a partner (create a lead for them); partners always act as themselves. */
export const ownerFor = (s, requested) => (s.role === 'admin' && requested ? requested : s.sub);
