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
import { SEATS, SEAT_LABELS } from './seats.js';
import { toUserDTO } from './users.mapper.js';

/**
 * Founders HQ "Accounts" (docs/SSO.md). An HQ account is a Mariox One user holding a seat
 * (`users.hq_seat`): the dialog lists them, creates new ones (Super Admin + seat), edits their name /
 * email, sets their portal password and removes a seat (HQ access only, the person stays). Ids in the
 * API are the seats' hq_users records, which keep the HQ-side data (authorship, prefs).
 */

const EMAIL_TAKEN = 'An account with this email already exists.';
const ACCOUNT_NOT_FOUND = 'We could not find that account.';
const ACCOUNT_FIELDS = 'name email status last_active_at hq_seat pp_user_id';
const NAME_MAX = 80;

const byEmail = (email, exceptUserId) => User.exists({ email, ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}) }).collation(CASE_INSENSITIVE);

/**
 * The hq_users record of a seat holder's seat, created on first use; its name / email follow the
 * holder. A different person taking over a seat starts with default UI prefs.
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

/** Portal users holding a seat, founder seat first. */
async function seatHolders() {
  const users = await User.find({ hq_seat: { $in: SEATS } }).select(ACCOUNT_FIELDS).rows();
  return users.sort((a, b) => SEATS.indexOf(a.hq_seat) - SEATS.indexOf(b.hq_seat));
}

const dtoOf = async (user) => toUserDTO(await ensureSeatRecord({ ...user, hqSeat: user.hq_seat }), user);

/** The seat holder behind an account id (a seat record id); 404 when the seat is unknown or empty. */
async function holderOf(recordId) {
  const record = await HqUser.findById(recordId).select('seat').lean();
  const user = record && await User.findOne({ hq_seat: record.seat }).select(ACCOUNT_FIELDS).rows();
  if (!user) throw notFound(ACCOUNT_NOT_FOUND);
  return user;
}

/** Pick the requested seat if free, or the first free seat; 409 when none fits. */
function chooseSeat(requestedSeat, taken) {
  if (requestedSeat) {
    if (taken.has(requestedSeat)) {
      throw conflict(taken.size >= SEATS.length ? 'Both seats are taken.' : `The ${SEAT_LABELS[requestedSeat]} seat is already taken.`);
    }
    return requestedSeat;
  }
  const free = SEATS.find((seat) => !taken.has(seat));
  if (!free) throw conflict('Both seats are taken.');
  return free;
}

/** All HQ accounts, founder seat first. */
export async function listUsers() {
  return Promise.all((await seatHolders()).map(dtoOf));
}

/**
 * New HQ account = a new Mariox One user: Super Admin, title Founder / Co-founder, the seat, and the
 * password set here (active straight away).
 * @param {object} req the request (audit log actor)
 * @param {{ name: string, email: string, password: string, seat?: string }} input
 */
export async function createUser(req, { name, email, password, seat }) {
  if (await byEmail(email)) throw conflict(EMAIL_TAKEN);
  const chosenSeat = chooseSeat(seat, new Set((await seatHolders()).map((u) => u.hq_seat)));
  const id = await nextId('user');
  try {
    await User.insertMany([{
      id, name, email, title: SEAT_LABELS[chosenSeat], role_id: SUPER_ROLE, dept: 'Management', status: 'Active',
      join_date: new Date().toISOString().slice(0, 10), password_hash: await bcrypt.hash(password, config.bcryptRounds), hq_seat: chosenSeat,
    }]);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    throw conflict(error.keyPattern?.hq_seat ? 'That seat was just taken. Please try again.' : EMAIL_TAKEN);
  }
  await ensureFounderOwner(id); // founders own leads
  await audit(req, `added ${name} as ${SEAT_LABELS[chosenSeat]} (Super Admin, Founders HQ)`, 'Invite');
  return dtoOf(await User.findOne({ id }).select(ACCOUNT_FIELDS).rows());
}

/**
 * Rename / change the email of the person holding a seat (their Mariox One account).
 * @param {string} recordId
 * @param {{ name?: string, email?: string }} changes
 */
export async function updateUser(recordId, changes) {
  const user = await holderOf(recordId);
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
 * Remove a seat: the person loses Founders HQ access but keeps their account. Nobody can remove their
 * own seat (so the HQ is never left without access).
 */
export async function deleteUser(req, recordId) {
  const user = await holderOf(recordId);
  if (user.id === req.actor.id) throw forbidden("You can't remove your own account.");
  await User.updateOne({ id: user.id, hq_seat: user.hq_seat }, { $set: { hq_seat: null } });
  await audit(req, `removed ${user.name}’s Founders HQ access`, 'Access');
}
