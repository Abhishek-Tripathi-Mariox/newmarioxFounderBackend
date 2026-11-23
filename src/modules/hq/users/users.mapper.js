import { hqRoleOf, roleLabel } from './seats.js';

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * Public representation of an HQ account: the member's hq_users record id and HQ person id (`seat`),
 * their role ('founder' | 'cofounder', label in `seatLabel`), the portal user's id, name, email and
 * last activity. Never includes secrets or prefs.
 * @param {{ _id: unknown, seat: string, createdAt?: Date }} record  the member's hq_users record
 * @param {{ id?: string, name: string, email: string, hq_role?: string|null, last_active_at?: Date | null }} account  the portal user
 */
export function toUserDTO(record, account) {
  const role = hqRoleOf({ hq_seat: record.seat, hq_role: account.hq_role });
  return {
    id: String(record._id),
    userId: account.id ?? record.user_id ?? null,
    name: account.name,
    email: account.email,
    seat: record.seat,
    role,
    seatLabel: roleLabel(role),
    createdAt: toIso(record.createdAt),
    lastLoginAt: toIso(account.last_active_at),
  };
}
