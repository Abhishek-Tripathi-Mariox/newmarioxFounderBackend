import { defineModel, text, oneOf, int, dec, day, ts, texts, REQUIRED, CASE_INSENSITIVE } from '../modelKit.js';

/** Unique only when set (Postgres UNIQUE ignores NULLs). */
const uniqueWhenSet = (field) => [{ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: 'string' } } }];

export const USER_STATUSES = ['Active', 'Invited', 'Deactivated'];

/**
 * Founders HQ membership (docs/SSO.md "Founders HQ members"). Any number of people can be HQ members,
 * each with a role and a stable HQ person id:
 *   - `hq_seat`: the person id the HQ workspace uses for them (task owners, agreements, prefs …).
 *     The two original seats keep their ids ('rahul', 'saswat') so existing workspace data stays
 *     valid; anyone given access later gets an id derived from their user id (e.g. 'u-1b').
 *   - `hq_role`: 'founder' | 'cofounder'. Older documents have no role: hqRoleOf() derives it
 *     ('rahul' → founder, anyone else → co-founder) on read, and the next save stores it.
 */
export const HQ_ROLES = Object.freeze(['founder', 'cofounder']);
export const HQ_ROLE_LABELS = Object.freeze({ founder: 'Founder', cofounder: 'Co-founder' });
/** The original two seats → their role. They can still be claimed explicitly (old API clients). */
export const LEGACY_HQ_SEATS = Object.freeze({ rahul: 'founder', saswat: 'cofounder' });
/** HQ person ids: lowercase, start with a letter; values the HQ workspace uses for groups are reserved. */
export const HQ_SEAT_RE = /^[a-z][a-z0-9-]{1,47}$/;
const RESERVED_HQ_IDS = new Set(['both', 'team', 'all', 'any', 'none']);
export const isHqSeatId = (v) => typeof v === 'string' && HQ_SEAT_RE.test(v) && !RESERVED_HQ_IDS.has(v);

/** A user's effective HQ role (null without access), normalising documents saved before roles existed. */
export const hqRoleOf = (u) => {
  if (!u?.hq_seat) return null;
  return HQ_ROLES.includes(u.hq_role) ? u.hq_role : (LEGACY_HQ_SEATS[u.hq_seat] || 'cofounder');
};

/** Portal accounts. `email` is citext: kept as typed, unique case-insensitively (query it with CASE_INSENSITIVE). */
export const User = defineModel('users', {
  name: text(REQUIRED),
  email: text(REQUIRED),
  phone: text(''),
  title: text(''),
  role_id: text(REQUIRED), // → roles
  dept: text(''),
  reports_to: text(), // → users, SET NULL on delete
  join_date: day(),
  status: oneOf(USER_STATUSES, 'Invited'),
  invited_at: ts(),
  last_active_at: ts(),
  hue: int(265),
  password_hash: text(), // null until the invite is accepted
  member_id: text(), // → members, SET NULL
  owner_id: text(), // → sales_owners, SET NULL
  client_of: texts(), // project ids (client users)
  shift_hours: dec(2, 8),
  invite_token_hash: text(),
  invite_expires_at: ts(),
  reset_token_hash: text(),
  reset_expires_at: ts(),
  // Founders HQ access (docs/SSO.md); set only by a Super Admin. hq_seat = HQ person id, unique when set.
  hq_seat: { type: String, default: null, validate: { validator: (v) => v == null || isHqSeatId(v), message: 'Invalid Founders HQ person id' } },
  hq_role: oneOf(HQ_ROLES, null),
  pp_user_id: text(), // → pp_users: the person's Mariox Partners profile (partner, or partner-admin profile)
}, {
  indexes: [
    [{ email: 1 }, { unique: true, collation: CASE_INSENSITIVE }],
    [{ role_id: 1 }],
    [{ reports_to: 1 }],
    uniqueWhenSet('member_id'),
    uniqueWhenSet('owner_id'),
    uniqueWhenSet('invite_token_hash'),
    uniqueWhenSet('reset_token_hash'),
    uniqueWhenSet('hq_seat'),
    uniqueWhenSet('pp_user_id'),
  ],
});
