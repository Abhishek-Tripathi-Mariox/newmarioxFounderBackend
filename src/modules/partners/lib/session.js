import { PpUser, User } from '../../../db/models/index.js';
import { resolveSession } from '../../../middleware/authenticate.js';
import { can } from '../../../middleware/authorize.js';
import { PP_MODULES, canPartnerAdmin, hasAction } from '../../../core/permissions.js';
import { appsOf } from '../../auth/auth.service.js';
import { PpError } from './http.js';

/**
 * Who is using the partner portal (docs/SSO.md). There is no partner-portal login any more: the
 * person is the one signed in to Mariox One (the portal's `mx_refresh` session cookie, or a Bearer
 * access token), and their Mariox Partners identity is a `pp_users` profile linked by `users.pp_user_id`:
 *   - role Partner (`r-partner`) → their partner profile (must exist and not be disabled);
 *   - Super Admin or a role that can view any partner admin module (`pp_*`, src/core/permissions.js)
 *     → their partner-admin profile, created and linked on first use. What they may see and change is
 *     checked per route and section with `adminCan(module, action)`.
 *
 * Sets `req.pp = { sub, role: 'admin'|'partner', name, userId, tokenHash, apps, perms, principal }`: `sub` is
 * the pp_users id the services scope by, `userId` / `tokenHash` the portal account and this device's
 * session, `apps` the areas the person can open (same shape as the portal auth payload), `perms` the
 * admin's partner-module permissions ({} for partners), `principal` the portal user.
 *
 * 401 = no valid Mariox One session (the frontend sends people to /login); 403 = signed in without
 * access to this part of Mariox Partners (the frontend shows "no access").
 */

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

/** The admin's partner-module permissions, `{ pp_acq: { v, c, e, d }, … }` (Super Admin: everything that exists). */
export function ppPermsOf(principal) {
  return Object.fromEntries(PP_MODULES.map((m) => [m, Object.fromEntries(['v', 'c', 'e', 'd'].map((a) => [a, hasAction(m, a) && can(principal, m, a)]))]));
}

/** Middleware: requires a portal session with access to Mariox Partners; sets `req.pp`. */
export async function requireSession(req, _res, next) {
  const { principal, tokenHash, reason } = await resolveSession(req);
  if (!principal) throw new PpError(401, SESSION_ERRORS[reason]);

  let pp;
  if (principal.isPartner) {
    const profile = await partnerProfile(principal);
    pp = { sub: String(profile._id), role: 'partner', name: profile.name, perms: {} };
  } else {
    if (!canPartnerAdmin(principal)) throw new PpError(403, 'Your role has no access to Mariox Partners');
    const profile = await adminProfile(principal);
    pp = { sub: String(profile._id), role: 'admin', name: profile.name, perms: ppPermsOf(principal) };
  }
  req.pp = { ...pp, userId: principal.id, tokenHash, apps: appsOf(principal), principal };
  next();
}

/** Middleware (after requireSession): partner-portal admins only. */
export function requireAdmin(req, _res, next) {
  if (req.pp?.role !== 'admin') throw new PpError(403, 'Admins only');
  next();
}

const VERB = { v: 'view', c: 'add', e: 'change', d: 'delete' };
const SECTION = {
  pp_overview: 'the overview', pp_acq: 'partner acquisition', pp_partners: 'partners', pp_leads: 'partner leads',
  pp_projects: 'projects and payouts', pp_requests: 'requests', pp_kit: 'the sales kit', pp_settings: 'settings',
};
const denied = (mod, act) => new PpError(403, `Your role can’t ${VERB[act]} ${SECTION[mod]} in Mariox Partners`);

/** Does this admin's role allow `act` on partner module `mod`? (false for partners) */
export const adminMay = (s, mod, act = 'v') => s.role === 'admin' && !!s.perms?.[mod]?.[act];

/**
 * Middleware (after requireSession): an admin's role must allow `act` on partner module `mod`.
 * Partners pass (the route serves them their own records); use `adminOnly` for admin-only routes.
 */
export const adminCan = (mod, act = 'v') => (req, _res, next) => {
  if (req.pp.role === 'admin' && !adminMay(req.pp, mod, act)) throw denied(mod, act);
  next();
};

/** Middleware: admins only, and their role must allow `act` on `mod`. */
export const adminOnly = (mod, act = 'v') => [requireAdmin, adminCan(mod, act)];

/** Throws 403 unless the admin may `act` on `mod` (for checks that depend on the request body). */
export function assertAdminMay(s, mod, act) {
  if (!adminMay(s, mod, act)) throw denied(mod, act);
}

/** Partners only ever see their own records; admins see everything. */
export const scope = (s) => (s.role === 'admin' ? {} : { owner: s.sub });

/** Admins can act for a partner (create a lead for them); partners always act as themselves. */
export const ownerFor = (s, requested) => (s.role === 'admin' && requested ? requested : s.sub);
