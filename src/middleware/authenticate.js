import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { Member, RefreshToken, Role, SalesOwner, User } from '../db/models/index.js';
import { ensureFounderOwner } from '../modules/people/founderOwners.js';
import { PARTNER_ROLE, SUPER_ROLE } from '../db/models/roles.js';
import { normalisePerms } from '../core/permissions.js';
import { hqRoleOf } from '../db/models/users.js';
import { TEXT_ORDER } from '../db/modelKit.js';
import { unauthorized, forbidden } from '../core/errors.js';
import { REFRESH_COOKIE, hashToken } from '../core/tokens.js';

/**
 * "Person id" used by attendance, time logs and live status: member id, else sales-owner id, else the
 * user id without "u-". A founder's lead-owner profile (`founderOwner`) doesn't count: it isn't sales
 * staff, so their attendance id stays the same.
 */
const personIdOf = (u, founderOwner = false) => u.member_id || (founderOwner ? null : u.owner_id) || u.id.replace(/^u-/, '');

/**
 * Load a user with their role and the derived "person id" (pid) used by attendance,
 * time logs and live status: the member id for delivery staff, the sales-owner id for sales.
 * `withReportees: false` skips the "Reports to" tree (Partners / HQ requests don't use it).
 */
export async function loadPrincipal(userId, { withReportees = true } = {}) {
  const u = await User.findOne({ id: userId })
    .select('name email status member_id owner_id client_of dept shift_hours role_id hq_seat hq_role pp_user_id').rows();
  if (!u) return null;
  // Founders own leads: their sales-owner profile is created on first need.
  if (u.hq_seat && !u.owner_id) u.owner_id = await ensureFounderOwner(u.id);
  const [role, member, owner] = await Promise.all([
    Role.findOne({ id: u.role_id }).select('name perms').rows(),
    u.member_id ? Member.findOne({ id: u.member_id }).select('team').rows() : null,
    u.owner_id && !u.member_id ? SalesOwner.findOne({ id: u.owner_id }).select('founder').rows() : null,
  ]);
  if (!role) return null; // users.role_id is a required reference (the old inner join)
  const hasReportees = withReportees && role.id !== SUPER_ROLE && role.id !== PARTNER_ROLE;
  const reportees = hasReportees ? await reporteesOf(u.id) : [];
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    // Every module present; a legacy single `pp` switch is expanded into the partner modules.
    role: { id: role.id, name: role.name, perms: normalisePerms(role.perms) },
    isSuper: role.id === SUPER_ROLE,
    isPartner: role.id === PARTNER_ROLE,
    hqSeat: u.hq_seat || null, // Founders HQ person id (docs/SSO.md)
    hqRole: hqRoleOf(u), // 'founder' | 'cofounder' | null
    ppUserId: u.pp_user_id || null,
    memberId: u.member_id,
    ownerId: u.owner_id,
    clientOf: u.client_of || [],
    team: member?.team || null,
    dept: u.dept,
    shiftHours: Number(u.shift_hours) || 8,
    pid: personIdOf(u, !!owner?.founder),
    // Active people who report to this user — directly or further down the chain ("Reports to").
    reportees,
  };
}

/** Same depth limit as the old recursive query: a reporting loop can't run away. */
const MAX_REPORTING_DEPTH = 10;

/**
 * Everyone under `userId` in the "Reports to" hierarchy (direct and indirect), active accounts
 * only, clients, partners and Super Admins excluded, sorted by name: [{id, pid, name, role, team}].
 */
export async function reporteesOf(userId, session = null) {
  const [root] = await User.aggregate([
    { $match: { _id: userId } },
    {
      $graphLookup: {
        from: User.collection.name,
        startWith: '$_id',
        connectFromField: '_id',
        connectToField: 'reports_to',
        as: 'tree',
        maxDepth: MAX_REPORTING_DEPTH - 1,
        restrictSearchWithMatch: { _id: { $ne: userId } },
      },
    },
    { $project: { tree: { _id: 1 } } },
  ]).session(session);
  const ids = (root?.tree || []).map((t) => t._id);
  if (!ids.length) return [];
  const users = await User.find({ id: { $in: ids }, status: 'Active', role_id: { $nin: ['r-client', PARTNER_ROLE, SUPER_ROLE] } })
    .select('name member_id owner_id role_id').sort({ name: 1, _id: 1 }).collation(TEXT_ORDER).session(session).rows();
  const [roles, members] = await Promise.all([
    Role.find({ id: { $in: [...new Set(users.map((u) => u.role_id))] } }).select('name').session(session).rows(),
    Member.find({ id: { $in: users.map((u) => u.member_id).filter(Boolean) } }).select('team').session(session).rows(),
  ]);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const teamOf = new Map(members.map((m) => [m.id, m.team]));
  return users.map((u) => ({ id: u.id, pid: personIdOf(u), name: u.name, role: roleName.get(u.role_id), team: teamOf.get(u.member_id) || null }));
}

/**
 * Requires `Authorization: Bearer <access token>`.
 * Sets req.actor (who is signed in) and req.user (whose permissions apply). They differ only when
 * a Super Admin sends `X-View-As: <userId>` to preview the portal as someone else — the same
 * "Preview as" feature as the frontend. Writes are still attributed to req.actor in audit logs.
 */
export async function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.accessSecret);
  } catch (e) {
    throw unauthorized(e.name === 'TokenExpiredError' ? 'Session expired — refresh your token' : 'Invalid token');
  }
  const actor = await loadPrincipal(payload.sub);
  if (!actor || actor.status !== 'Active') throw unauthorized('Account is not active');
  req.actor = actor;
  req.user = actor;

  const viewAs = req.get('x-view-as');
  if (viewAs && viewAs !== actor.id) {
    if (!actor.isSuper) throw forbidden('Only a Super Admin can preview as another user');
    const target = await loadPrincipal(viewAs);
    if (!target || target.status !== 'Active') throw forbidden('Preview user is not active');
    req.user = target;
    req.previewing = true;
  }
  next();
}

/** The internal API is staff-only: partner accounts (and previews of one) get 403 outside /auth (docs/SSO.md). */
export function refusePartners(req, _res, next) {
  if (req.user.isPartner) throw forbidden('Partner accounts can only open Mariox Partners');
  next();
}

/**
 * Who is signed in, for the areas that ride on the portal session instead of the Bearer-only internal
 * API (Mariox Partners /pp, Founders HQ /hq): the `mx_refresh` cookie when present (stored, not
 * revoked, not expired), else a Bearer access token. The account must be Active.
 * @returns {Promise<{ principal: object, tokenHash: string | null } | { reason: 'none' | 'ended' | 'inactive' }>}
 *   `none` = no (usable) credentials, `ended` = the session was signed out / expired, `inactive` = account not Active.
 */
export async function resolveSession(req) {
  const cookie = req.cookies?.[REFRESH_COOKIE];
  let userId;
  let tokenHash = null;
  if (cookie) {
    tokenHash = hashToken(cookie);
    const row = await RefreshToken.findOne({ token_hash: tokenHash }).select('user_id revoked_at expires_at').rows();
    if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) return { reason: 'ended' };
    userId = row.user_id;
  } else {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return { reason: 'none' };
    try {
      userId = jwt.verify(header.slice(7), config.jwt.accessSecret).sub;
    } catch {
      return { reason: 'none' };
    }
  }
  const principal = await loadPrincipal(userId, { withReportees: false });
  if (!principal || principal.status !== 'Active') return { reason: 'inactive' };
  return { principal, tokenHash };
}
