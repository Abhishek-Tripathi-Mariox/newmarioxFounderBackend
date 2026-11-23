import { randomBytes } from 'node:crypto';
import { HqUser } from '../../../db/models/hq_users.js';
import { User } from '../../../db/models/index.js';
import { HQ_ROLES, HQ_ROLE_LABELS, LEGACY_HQ_SEATS, hqRoleOf, isHqSeatId } from '../../../db/models/users.js';

/**
 * Founders HQ members (docs/SSO.md): any number of Founders and Co-founders. Each member's
 * `users.hq_seat` is their HQ person id (unique), `users.hq_role` their role.
 */
export { HQ_ROLES, HQ_ROLE_LABELS, LEGACY_HQ_SEATS, hqRoleOf };

/** The two original seat ids, which old clients may still claim explicitly. */
export const LEGACY_SEATS = Object.freeze(Object.keys(LEGACY_HQ_SEATS));

export const roleLabel = (role) => HQ_ROLE_LABELS[role] || HQ_ROLE_LABELS.cofounder;

/** Filter for "users who are HQ members". */
export const MEMBER_FILTER = Object.freeze({ hq_seat: { $type: 'string' } });

/** Display order of members: founders first, the original seats first, then oldest account first. */
export function compareMembers(a, b) {
  const byRole = HQ_ROLES.indexOf(a.role) - HQ_ROLES.indexOf(b.role);
  if (byRole) return byRole;
  const legacyRank = (seat) => (LEGACY_SEATS.includes(seat) ? LEGACY_SEATS.indexOf(seat) : LEGACY_SEATS.length);
  const byLegacy = legacyRank(a.seat) - legacyRank(b.seat);
  if (byLegacy) return byLegacy;
  const time = (v) => (v ? new Date(v).getTime() : 0);
  return time(a.since) - time(b.since) || String(a.name).localeCompare(String(b.name));
}

const heldByOther = async (seat, userId, session) => {
  const holder = await User.findOne({ hq_seat: seat }).select('_id').session(session).rows();
  return !!holder && holder.id !== userId;
};

/**
 * The HQ person id for a user who is being given HQ access. Someone who had access before gets their
 * old id back (their hq_users record), so their earlier tasks, agreements and prefs are theirs again;
 * anyone else gets an id derived from their user id ('u-1b'), which never collides with another user.
 * @param {string} userId
 * @param {import('mongoose').ClientSession|null} [session]
 */
export async function personIdFor(userId, session = null) {
  const previous = await HqUser.find({ user_id: userId }).sort({ updatedAt: -1 }).select('seat').session(session).lean();
  for (const record of previous) {
    if (isHqSeatId(record.seat) && !(await heldByOther(record.seat, userId, session))) return record.seat;
  }
  const derived = String(userId).toLowerCase();
  if (isHqSeatId(derived) && !LEGACY_SEATS.includes(derived) && !(await heldByOther(derived, userId, session))) return derived;
  return `p-${randomBytes(5).toString('hex')}`;
}
