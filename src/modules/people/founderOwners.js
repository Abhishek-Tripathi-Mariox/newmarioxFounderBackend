/**
 * Founders as lead owners. The Founder and the Co-founder (users with an `hq_seat`) own and assign
 * leads like the sales team, so each gets a sales-owner profile (`sales_owners`, `founder: true`)
 * linked through `users.owner_id`. It is created when the seat is given (Users & roles, Founders HQ
 * Accounts), by the seed, and on first need (sign-in, the sales-owner list), and its name follows the
 * account. A founder profile isn't sales staff: Live, attendance and reports leave it out
 * (workday.repository.people, frontend domain/attendance), and the person's attendance id stays what
 * it was (middleware/authenticate personIdOf).
 */
import { nextId } from '../../core/ids.js';
import { SalesOwner, User } from '../../db/models/index.js';
import { HQ_SEATS } from '../../db/models/users.js';

const randomHue = () => Math.floor(Math.random() * 360);

/** A new sales-owner id (same scheme as users.service syncPeople: 's' + the next member number). */
export const newOwnerId = async () => `s${(await nextId('member')).slice(1)}`;

/**
 * Make sure a seat holder has a sales-owner profile and that its name follows the account.
 * Users without a seat are left alone. Idempotent; safe when two requests race (the user is linked
 * with a conditional update, the loser's profile is removed again).
 * @param {string} userId
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<string|null>} the user's sales-owner id (null when they have none)
 */
export async function ensureFounderOwner(userId, session = null) {
  const user = await User.findOne({ id: userId }).select('name hue status owner_id hq_seat').session(session).rows();
  if (!user) return null;
  if (user.owner_id) {
    if (user.hq_seat) await SalesOwner.updateOne({ id: user.owner_id, name: { $ne: user.name } }, { name: user.name }, { session });
    return user.owner_id;
  }
  if (!user.hq_seat) return null;
  const ownerId = await newOwnerId();
  await SalesOwner.insertMany([{
    id: ownerId, name: user.name, hue: user.hue ?? randomHue(), active: user.status !== 'Deactivated', founder: true,
  }], { session });
  const linked = await User.updateOne({ id: userId, owner_id: null }, { owner_id: ownerId }, { session });
  if (linked.modifiedCount) return ownerId;
  // Someone linked a profile first: keep theirs.
  await SalesOwner.deleteOne({ id: ownerId }, { session });
  const again = await User.findOne({ id: userId }).select('owner_id').session(session).rows();
  return again?.owner_id ?? null;
}

/** ensureFounderOwner for every seat holder still without a sales-owner profile (cheap when none). */
export async function ensureFounderOwners(session = null) {
  const missing = await User.find({ hq_seat: { $in: HQ_SEATS }, owner_id: null }).select('_id').session(session).rows();
  for (const u of missing) await ensureFounderOwner(u.id, session);
}
