import { defineModel, text, oneOf, int, dec, day, ts, texts, REQUIRED, CASE_INSENSITIVE } from '../modelKit.js';

/** Unique only when set (Postgres UNIQUE ignores NULLs). */
const uniqueWhenSet = (field) => [{ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: 'string' } } }];

export const USER_STATUSES = ['Active', 'Invited', 'Deactivated'];

/** Founders HQ seats (values the HQ frontend uses), founder first: 'rahul' = Founder, 'saswat' = Co-founder. */
export const HQ_SEATS = Object.freeze(['rahul', 'saswat']);
export const HQ_SEAT_LABELS = Object.freeze({ rahul: 'Founder', saswat: 'Co-founder' });

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
  hq_seat: oneOf(HQ_SEATS, null), // Founders HQ access (docs/SSO.md); set only by a Super Admin
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
