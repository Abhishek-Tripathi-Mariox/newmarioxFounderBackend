/**
 * Founders HQ founder seat (HQ_FOUNDER_EMAIL / HQ_FOUNDER_PASSWORD / HQ_FOUNDER_NAME), optional.
 *
 * With the one login (docs/SSO.md) the founder is a Mariox One Super Admin holding the Founder seat
 * (`users.hq_seat = 'rahul'`):
 *   - HQ_FOUNDER_EMAIL is an existing Super Admin (e.g. the same person as SUPER_ADMIN_EMAIL) → that
 *     account gets the seat;
 *   - nobody uses the email → a new Super Admin "Founder" with the seat is created (empty password =
 *     generated and printed once).
 * Idempotent: once the Founder seat is held nothing changes, and a password is never reset.
 *
 * Mariox Partners needs no account of its own: Super Admins (and roles with the `pp` permission) are
 * its admins, so the old PP_ADMIN_* settings are not used any more.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { nextId } from '../../core/ids.js';
import { CASE_INSENSITIVE } from '../modelKit.js';
import { User } from '../models/index.js';
import { SUPER_ROLE } from '../models/roles.js';
import { HQ_SEAT_LABELS } from '../models/users.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOUNDER_SEAT = 'rahul';
const LABEL = 'Founders HQ founder';

/**
 * @returns {Promise<{ seated: boolean, created: boolean, user?: object, password?: string }>}
 *   `password` only when one was generated for a new account.
 */
export async function createFounder({
  email = process.env.HQ_FOUNDER_EMAIL,
  password = process.env.HQ_FOUNDER_PASSWORD,
  name = process.env.HQ_FOUNDER_NAME || 'Founder',
  rounds = Number(process.env.BCRYPT_ROUNDS) || 10,
  log = console.log,
} = {}) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) {
    log(`${LABEL} seed: HQ_FOUNDER_EMAIL not set — skipped.`);
    return { seated: false, created: false };
  }
  if (!EMAIL_RE.test(address)) throw new Error(`${LABEL}: the email "${address}" is not valid.`);
  if (password && password.length < 8) throw new Error(`${LABEL}: the password must be at least 8 characters.`);

  const holder = await User.findOne({ hq_seat: FOUNDER_SEAT }).select('email').rows();
  if (holder) {
    log(`${LABEL} seed: the Founder seat is already held by ${holder.email} — nothing changed.`);
    return { seated: false, created: false };
  }

  const existing = await User.findOne({ email: address }).collation(CASE_INSENSITIVE).select('email role_id').rows();
  if (existing) {
    if (existing.role_id !== SUPER_ROLE) throw new Error(`${LABEL}: ${existing.email} is not a Super Admin, so it can't hold the Founder seat.`);
    await User.updateOne({ id: existing.id, hq_seat: null }, { hq_seat: FOUNDER_SEAT });
    log(`${LABEL} seed: gave ${existing.email} the Founder seat.`);
    return { seated: true, created: false, user: existing };
  }

  const pw = password || randomBytes(12).toString('base64url');
  const [user] = await User.insertRows([{
    id: await nextId('user'),
    name: String(name).trim() || 'Founder',
    email: address,
    title: HQ_SEAT_LABELS[FOUNDER_SEAT],
    role_id: SUPER_ROLE,
    dept: 'Management',
    join_date: new Date().toISOString().slice(0, 10),
    status: 'Active',
    password_hash: await bcrypt.hash(pw, rounds),
    hq_seat: FOUNDER_SEAT,
  }]);
  log(`${LABEL} seed: created Super Admin ${address} with the Founder seat${password ? '' : ` and generated password: ${pw}  (change it after first sign-in)`}`);
  return { seated: true, created: true, user, password: password ? undefined : pw };
}
