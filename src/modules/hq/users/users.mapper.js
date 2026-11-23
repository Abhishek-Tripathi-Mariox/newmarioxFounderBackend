import { SEAT_LABELS } from './seats.js';

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * Public representation of an HQ account: the seat record's id and seat, the holder's (portal
 * user's) name, email and last activity. Never includes secrets or prefs.
 * @param {{ _id: unknown, seat: string, createdAt?: Date }} record  the seat's hq_users record
 * @param {{ name: string, email: string, last_active_at?: Date | null }} account  the portal user holding the seat
 */
export function toUserDTO(record, account) {
  return {
    id: String(record._id),
    name: account.name,
    email: account.email,
    seat: record.seat,
    seatLabel: SEAT_LABELS[record.seat] ?? record.seat,
    createdAt: toIso(record.createdAt),
    lastLoginAt: toIso(account.last_active_at),
  };
}
