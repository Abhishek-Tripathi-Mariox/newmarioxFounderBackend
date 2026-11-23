import bcrypt from 'bcryptjs';
import { config } from '../../../config/index.js';
import { audit } from '../../../core/audit.js';
import { nextId } from '../../../core/ids.js';
import { HqUser } from '../../../db/models/hq_users.js';
import { PpUser, User } from '../../../db/models/index.js';
import { CASE_INSENSITIVE } from '../../../db/modelKit.js';
import { SUPER_ROLE } from '../../../db/models/roles.js';
import { replacePassword } from '../../auth/auth.service.js';
import { ensureFounderOwner } from '../../people/founderOwners.js';
import { conflict, forbidden, notFound } from '../core/errors.js';
import { LEGACY_HQ_SEATS, MEMBER_FILTER, compareMembers, hqRoleOf, personIdFor, roleLabel } from './seats.js';
import { toUserDTO } from './users.mapper.js';

/**
 * Founders HQ "Accounts" (docs/SSO.md). An HQ account is a Mariox One user who is an HQ member
 * (`users.hq_seat` = their HQ person id, `users.hq_role` = founder / co-founder; any number of each):
 * the dialog lists them, creates new ones (Super Admin + membership), edits their name / email / role,
 * sets their portal password and removes a member (HQ access only, the person stays). Ids in the API
 * are the members' hq_users records, which keep the HQ-side data (authorship, prefs).
 */

const EMAIL_TAKEN = 'An account with this email already exists.';
const ACCOUNT_NOT_FOUND = 'We could not find that account.';
const ACCOUNT_FIELDS = 'name email status last_active_at hq_seat hq_role pp_user_id created_at';
const NAME_MAX = 80;

const byEmail = (email, exceptUserId) => User.exists({ email, ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}) }).collation(CASE_INSENSITIVE);

/**
 * The hq_users record of a member's HQ person id, created on first use; its name / email follow the
 * member. A different person taking over an id starts with default UI prefs.
 * @param {{ id: string, name: string, email: string, hqSeat: string }} holder  portal principal / user
 */
export async function ensureSeatRecord({ id, name, email, hqSeat }) {
  const seat = hqSeat;
  const wanted = { name: name.slice(0, NAME_MAX), email: email.trim().toLowerCase(), user_id: id };
  const existing = await HqUser.findOne({ seat }).lean();
  if (existing && Object.entries(wanted).every(([k, v]) => existing[k] === v)) return existing;
  const set = existing?.user_id && existing.user_id !== id ? { ...wanted, prefs: {} } : wanted;
  try {
    return await HqUser.findOneAndUpdate({ seat }, { $set: set }, { upsert: true, new: true, runValidators: true }).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return HqUser.findOneAndUpdate({ seat }, { $set: set }, { new: true, runValidators: true }).lean(); // a concurrent first use created it
  }
}

/** Portal users who are HQ members. */
const members = () => User.find(MEMBER_FILTER).select(ACCOUNT_FIELDS).rows();

const dtoOf = async (user) => toUserDTO(await ensureSeatRecord({ ...user, hqSeat: user.hq_seat }), user);

/** The member behind an account id (an hq_users record id); 404 when unknown or no longer a member. */
async function holderOf(recordId) {
  const record = await HqUser.findById(recordId).select('seat').lean();
  const user = record && await User.findOne({ hq_seat: record.seat }).select(ACCOUNT_FIELDS).rows();
  if (!user) throw notFound(ACCOUNT_NOT_FOUND);
  return user;
}

/** All HQ accounts: founders first (the original seat first), then co-founders, oldest account first. */
export async function listUsers() {
  const key = (u) => ({ role: hqRoleOf(u), seat: u.hq_seat, since: u.created_at, name: u.name });
  const users = (await members()).sort((a, b) => compareMembers(key(a), key(b)));
  return Promise.all(users.map(dtoOf));
}

/**
 * New HQ account = a new Mariox One user: Super Admin, title Founder / Co-founder, HQ membership with
 * that role, and the password set here (active straight away). Any number of founders / co-founders.
 * `role` defaults to founder for the first member and co-founder after that; `seat` (older clients)
 * claims one of the two original person ids ('rahul' / 'saswat') and must be free.
 * @param {object} req the request (audit log actor)
 * @param {{ name: string, email: string, password: string, role?: 'founder'|'cofounder', seat?: string }} input
 */
export async function createUser(req, { name, email, password, role, seat }) {
  if (await byEmail(email)) throw conflict(EMAIL_TAKEN);
  const current = await members();
  const hqRole = role || (seat ? LEGACY_HQ_SEATS[seat] : current.length ? 'cofounder' : 'founder');
  if (seat && current.some((u) => u.hq_seat === seat)) throw conflict(`The ${roleLabel(LEGACY_HQ_SEATS[seat])} seat is already taken.`);
  const id = await nextId('user');
  const personId = seat || await personIdFor(id);
  try {
    await User.insertMany([{
      id, name, email, title: roleLabel(hqRole), role_id: SUPER_ROLE, dept: 'Management', status: 'Active',
      join_date: new Date().toISOString().slice(0, 10), password_hash: await bcrypt.hash(password, config.bcryptRounds),
      hq_seat: personId, hq_role: hqRole,
    }]);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    throw conflict(error.keyPattern?.hq_seat ? 'That seat was just taken. Please try again.' : EMAIL_TAKEN);
  }
  await ensureFounderOwner(id); // founders own leads
  await audit(req, `added ${name} as ${roleLabel(hqRole)} (Super Admin, Founders HQ)`, 'Invite');
  return dtoOf(await User.findOne({ id }).select(ACCOUNT_FIELDS).rows());
}

/**
 * Rename / change the email of a member (their Mariox One account) or change their HQ role.
 * @param {object} req the request (audit log actor)
 * @param {string} recordId
 * @param {{ name?: string, email?: string, role?: 'founder'|'cofounder' }} input
 */
export async function updateUser(req, recordId, { role, ...changes }) {
  const user = await holderOf(recordId);
  if (role && role !== hqRoleOf(user)) {
    await User.updateOne({ id: user.id, hq_seat: user.hq_seat }, { $set: { hq_role: role } });
    await audit(req, `made ${changes.name || user.name} ${roleLabel(role)} in Founders HQ`, 'Access');
    user.hq_role = role;
  }
  if (!Object.keys(changes).length) return dtoOf(user);
  if (changes.email && await byEmail(changes.email, user.id)) throw conflict(EMAIL_TAKEN);
  try {
    await User.updateOne({ id: user.id }, { $set: changes });
  } catch (error) {
    if (error?.code === 11000) throw conflict(EMAIL_TAKEN);
    throw error;
  }
  if (user.pp_user_id) await PpUser.updateOne({ _id: user.pp_user_id }, { $set: changes });
  await ensureFounderOwner(user.id); // their lead-owner profile follows the name
  return dtoOf({ ...user, ...changes });
}

/**
 * Set the seat holder's Mariox One password; every session of theirs ends.
 * @returns {Promise<string>} the portal user id whose password changed
 */
export async function setPassword(recordId, password) {
  const user = await holderOf(recordId);
  await replacePassword(user.id, password);
  return user.id;
}

/**
 * Remove a member: the person loses Founders HQ access but keeps their account (and their HQ person
 * id comes back if access is given again). Nobody can remove themselves (so the HQ is never left
 * without access).
 */
export async function deleteUser(req, recordId) {
  const user = await holderOf(recordId);
  if (user.id === req.actor.id) throw forbidden("You can't remove your own account.");
  await User.updateOne({ id: user.id, hq_seat: user.hq_seat }, { $set: { hq_seat: null, hq_role: null } });
  await audit(req, `removed ${user.name}’s Founders HQ access`, 'Access');
}
