import bcrypt from 'bcryptjs';
import { tx } from '../../db/mongo.js';
import { CASE_INSENSITIVE } from '../../db/modelKit.js';
import { AuditLog, PpUser, RefreshToken, User } from '../../db/models/index.js';
import { config } from '../../config/index.js';
import { unauthorized, unprocessable } from '../../core/errors.js';
import { signAccessToken, newRefreshToken, hashToken } from '../../core/tokens.js';
import { loadPrincipal } from '../../middleware/authenticate.js';
import { can } from '../../middleware/authorize.js';
import { canPartnerAdmin } from '../../core/permissions.js';

const INVALID = 'Invalid email or password';

/** The portal's usual landing (frontend firstAllowedTarget): first module the role can view. */
const PORTAL_LANDING = [
  ['dash', '/dashboard'], ['leads', '/leads'], ['fu', '/follow-ups'],
  ['projects', '/projects'], ['tasks', '/projects'], ['bugs', '/projects'], ['ts', '/projects'], ['team', '/projects'],
  ['users', '/users'],
];

/**
 * Which areas the person can open (docs/SSO.md "What each area accepts"): the internal portal,
 * Mariox Partners (as admin or partner) and Founders HQ (their HQ person id; `foundersRole` is their
 * role there, 'founder' | 'cofounder').
 */
export function appsOf(p) {
  let partners = null;
  if (p.isPartner) partners = p.ppUserId ? 'partner' : null;
  else if (canPartnerAdmin(p)) partners = 'admin'; // any partner admin section (pp_*) viewable
  return { portal: !p.isPartner, partners, founders: p.hqSeat || null, foundersRole: p.hqSeat ? p.hqRole || 'cofounder' : null };
}

/** Where to land after sign-in (the frontend applies a same-site `?next=` first). */
export function homeOf(p, apps = appsOf(p)) {
  if (p.isPartner) return '/partners/dashboard';
  if (apps.founders) return '/founders';
  if (p.isSuper) return '/live';
  const portal = PORTAL_LANDING.find(([mod]) => can(p, mod, 'v'))?.[1];
  // Partner admins with nothing to open in the portal land in the partner admin console.
  if (!portal && apps.partners === 'admin') return '/partners/admin';
  return portal || '/live';
}

/** Principal → the user object the frontend keeps for the session. */
export function principalDto(p) {
  if (!p) return null;
  const apps = appsOf(p);
  return {
    id: p.id, name: p.name, email: p.email, status: p.status, role: p.role, isSuper: p.isSuper, memberId: p.memberId,
    ownerId: p.ownerId, clientOf: p.clientOf, team: p.team, dept: p.dept, shiftHours: p.shiftHours, pid: p.pid,
    reportees: p.reportees || [], apps, home: homeOf(p, apps),
  };
}

/** A user by email, case-insensitively (citext semantics). */
const byEmail = (email, fields, session = null) => User.findOne({ email: email.trim() }).collation(CASE_INSENSITIVE).select(fields).session(session).rows();

/** Revoke every still-active refresh token of a user; returns how many were revoked. */
export async function revokeSessions(userId, session = null) {
  const r = await RefreshToken.updateMany({ user_id: userId, revoked_at: null }, { revoked_at: new Date() }, { session });
  return r.modifiedCount;
}

/** Revoke every active refresh token of a user except the one with `keepHash` ("sign out other devices"). */
export async function revokeOtherSessions(userId, keepHash) {
  const r = await RefreshToken.updateMany({ user_id: userId, revoked_at: null, token_hash: { $ne: keepHash } }, { revoked_at: new Date() });
  return r.modifiedCount;
}

/** Issue an access token + a stored (hashed) refresh token for a user (call after the user's changes are committed). */
export async function issueSession(userId, meta, session = null) {
  const principal = await loadPrincipal(userId);
  const rt = newRefreshToken();
  await RefreshToken.insertMany([{ user_id: userId, token_hash: rt.hash, expires_at: rt.expiresAt, user_agent: meta.userAgent || null, ip: meta.ip || null }], { session });
  return { accessToken: signAccessToken(principal), refreshToken: rt.token, user: principalDto(principal) };
}

const inactiveMsg = (status) => `This account is ${(status || 'inactive').toLowerCase()}. Ask an admin to activate it.`;

export async function login({ email, password }, meta) {
  const u = await byEmail(email, 'status password_hash pp_user_id');
  // Same message for unknown email and wrong password (no user enumeration).
  if (!u) throw unauthorized(INVALID);
  if (u.status !== 'Active') throw unauthorized(inactiveMsg(u.status));
  if (!u.password_hash || !(await bcrypt.compare(password, u.password_hash))) throw unauthorized(INVALID);
  const now = new Date();
  await User.updateOne({ id: u.id }, { last_active_at: now });
  if (u.pp_user_id) await PpUser.updateOne({ _id: u.pp_user_id }, { $set: { lastLoginAt: now } });
  return issueSession(u.id, meta);
}

/**
 * Rotate a refresh token: the presented token is revoked and a new one issued. Presenting a token
 * that was already revoked means it was stolen or replayed — every session of that user is revoked.
 * The revocation is a conditional update, so of two concurrent rotations of one token only the first
 * wins; the second counts as a replay.
 */
export async function refresh(token, meta) {
  if (!token) throw unauthorized('No refresh token');
  const result = await tx(async (session) => {
    const row = await RefreshToken.findOne({ token_hash: hashToken(token) }).session(session).rows();
    if (!row) throw unauthorized('Invalid refresh token');
    if (row.revoked_at) {
      await revokeSessions(row.user_id, session);
      return { reused: true };
    }
    if (new Date(row.expires_at) <= new Date()) throw unauthorized('Refresh token expired — sign in again');
    const user = await User.findOne({ id: row.user_id }).select('status').session(session).rows();
    if (!user || user.status !== 'Active') throw unauthorized('Account is not active');
    const claimed = await RefreshToken.updateOne({ id: row.id, revoked_at: null }, { revoked_at: new Date() }, { session });
    if (!claimed.modifiedCount) {
      await revokeSessions(row.user_id, session);
      return { reused: true };
    }
    await User.updateOne({ id: row.user_id }, { last_active_at: new Date() }, { session });
    return issueSession(row.user_id, meta, session);
  });
  // Thrown outside the transaction so the revocation above is committed.
  if (result.reused) throw unauthorized('Refresh token was already used — all sessions were signed out');
  return result;
}

export async function logout(token) {
  if (!token) return;
  await RefreshToken.updateOne({ token_hash: hashToken(token), revoked_at: null }, { revoked_at: new Date() });
}

/** Is `password` the user's current password? */
export async function isCurrentPassword(userId, password) {
  const u = await User.findOne({ id: userId }).select('password_hash').rows();
  return !!(u?.password_hash && (await bcrypt.compare(password, u.password_hash)));
}

/**
 * Set a user's password and sign them out everywhere (every refresh token revoked). Also used by
 * Mariox Partners and Founders HQ, whose passwords are this one (docs/SSO.md).
 * @param {object} [extra] more fields to set in the same write (e.g. activating an invited account)
 */
export async function replacePassword(userId, password, extra = {}) {
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await tx(async (session) => {
    await User.updateOne({ id: userId }, { password_hash: hash, reset_token_hash: null, reset_expires_at: null, ...extra }, { session });
    await revokeSessions(userId, session);
  });
}

export async function changePassword(userId, { currentPassword, newPassword }, meta) {
  if (!(await isCurrentPassword(userId, currentPassword))) throw unprocessable('Your current password is wrong.');
  // Sign out every other device; the caller gets a fresh session.
  await replacePassword(userId, newPassword);
  return issueSession(userId, meta);
}

/** Find a user by email whose one-time token (invite/reset) matches and has not expired. */
async function byOneTimeToken(email, token, kind) {
  const [hashCol, expCol] = kind === 'invite' ? ['invite_token_hash', 'invite_expires_at'] : ['reset_token_hash', 'reset_expires_at'];
  const u = await byEmail(email, `name status pp_user_id ${hashCol} ${expCol}`);
  if (!u || !u[hashCol] || u[hashCol] !== hashToken(token) || !u[expCol] || new Date(u[expCol]) <= new Date()) {
    throw unprocessable(kind === 'invite' ? 'This invite link is invalid or has expired. Ask an admin to resend it.' : 'This reset link is invalid or has expired.');
  }
  return u;
}

/** Invited person sets their password: account becomes Active and they are signed in. */
export async function acceptInvite({ email, token, password }, meta) {
  const u = await byOneTimeToken(email, token, 'invite');
  if (u.status !== 'Invited') throw unprocessable('This invite was already used.');
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await tx(async (session) => {
    // Conditional on status: of two concurrent accepts only one activates the account.
    const r = await User.updateOne(
      { id: u.id, status: 'Invited' },
      { password_hash: hash, status: 'Active', invite_token_hash: null, invite_expires_at: null, last_active_at: new Date() },
      { session },
    );
    if (!r.modifiedCount) throw unprocessable('This invite was already used.');
    await AuditLog.insertMany([{ actor_user_id: u.id, actor_name: u.name, text: `${u.name} accepted the invite`, kind: 'Invite' }], { session });
    // A partner's Mariox Partners profile follows the account.
    if (u.pp_user_id) await PpUser.updateOne({ _id: u.pp_user_id, status: 'invited' }, { $set: { status: 'active' } }, { session });
  });
  return issueSession(u.id, meta);
}

/** Complete an admin-issued password reset; signs the user out everywhere. */
export async function resetPassword({ email, token, password }) {
  const u = await byOneTimeToken(email, token, 'reset');
  if (u.status === 'Deactivated') throw unprocessable(inactiveMsg(u.status));
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await tx(async (session) => {
    await User.updateOne({ id: u.id }, { password_hash: hash, reset_token_hash: null, reset_expires_at: null }, { session });
    await revokeSessions(u.id, session);
  });
}
