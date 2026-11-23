import { PpUser, User } from '../../../db/models/index.js';
import { issueSession, isCurrentPassword, replacePassword, revokeOtherSessions as revokeOthers } from '../../auth/auth.service.js';
import { PpError } from '../lib/http.js';
import { publicUser } from '../lib/users.js';

/**
 * The signed-in profile (mariox-saas src/app/api/me/**). Password and sessions are the person's
 * Mariox One account (docs/SSO.md), `s.userId`.
 */

export async function get(s) {
  const user = await PpUser.findById(s.sub);
  if (!user) throw new PpError(401, 'Account not found');
  return publicUser(user);
}

/** Edit own details; a new name is the account's name everywhere. */
export async function updateProfile(s, fields) {
  const user = await PpUser.findByIdAndUpdate(s.sub, fields, { new: true });
  if (fields.name) await User.updateOne({ id: s.userId }, { name: fields.name });
  return publicUser(user);
}

/** Change own (portal) password: every session ends; returns a fresh session for this device. */
export async function changePassword(s, { currentPassword, newPassword }, meta) {
  if (!(await isCurrentPassword(s.userId, currentPassword))) throw new PpError(400, 'Current password is wrong');
  if (currentPassword === newPassword) throw new PpError(400, 'Choose a password you have not used just now');
  await replacePassword(s.userId, newPassword);
  return issueSession(s.userId, meta);
}

/** "Sign out of all other devices": every session of the account except this device's. */
export const revokeOtherSessions = (s) => revokeOthers(s.userId, s.tokenHash);
