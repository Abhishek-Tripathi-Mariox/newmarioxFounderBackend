import { PpBooking, PpFile, PpLead, PpProject, PpScope, PpTechRequest, PpTicket, PpUser, User } from '../../../db/models/index.js';
import { tx } from '../../../db/mongo.js';
import { storage } from '../../../core/storage/index.js';
import { replacePassword, revokeSessions } from '../../auth/auth.service.js';
import { removeUser } from '../../users/users.repository.js';
import { PpError } from '../lib/http.js';
import { eq, runList } from '../lib/list.js';
import { PORTAL_STATUS, createPartner, emailInvite, emailTaken, emailWelcome, newInvite, portalUserOf, publicUser } from '../lib/users.js';

/**
 * Partner accounts for portal admins (mariox-saas src/app/api/admin/users/**). Changes to a partner
 * also apply to their Mariox One account (docs/SSO.md): email, name, status (disabled ↔ Deactivated)
 * and password. Partner-admin profiles belong to staff accounts, which are managed in Users & roles.
 */

const STAFF_FIELDS = ['email', 'status', 'password', 'newInvite'];

const LIST = {
  search: ['name', 'email', 'company', 'partnerCode', 'phone', 'city'],
  sorts: ['createdAt', 'name', 'commissionRate', 'lastLoginAt', 'company'],
  defaultSort: '-createdAt',
  filters: { status: eq('status'), source: eq('source'), role: eq('role') },
};

export async function list(req) {
  const { items, meta } = await runList(PpUser, {}, req, LIST);
  return { users: items.map(publicUser), meta };
}

export async function find(id) {
  const user = await PpUser.findById(id);
  if (!user) throw new PpError(404, 'User not found');
  return user;
}

/** Active account with the password the admin chose; the welcome email says whether it went out (`mail`). */
export async function create(input) {
  const r = await createPartner(input, 'admin');
  const mail = await emailWelcome(r.user, input.password);
  return { ...r, mail };
}

/**
 * Edit details / status / rate; `password` sets a new one (signs the partner out, activates an
 * invited account, optionally emails it); `newInvite` makes and emails a fresh 7-day set-password link.
 */
export async function update(me, user, patch) {
  const { password, newInvite: wantsInvite, emailPassword, ...fields } = patch;
  if (String(user._id) === me.sub && fields.status === 'disabled') throw new PpError(400, "You can't suspend your own account");
  if (user.role === 'admin' && STAFF_FIELDS.some((k) => patch[k] !== undefined)) {
    throw new PpError(400, 'A partner admin’s email, status and password are managed in the team portal (Users & roles)');
  }
  const account = user.role === 'partner' ? await portalUserOf(user._id, 'status') : null;
  if (user.role === 'partner' && !account) throw new PpError(409, 'This partner has no Mariox One account');
  if (fields.email) {
    fields.email = fields.email.toLowerCase();
    if (await emailTaken(fields.email, { exceptPpUserId: user._id, exceptUserId: account?.id })) throw new PpError(409, 'A user with this email already exists');
  }

  user.set(fields);
  if (password && user.status === 'invited') user.status = 'active';
  const invite = wantsInvite ? newInvite() : null;
  if (invite) {
    user.inviteToken = invite.hash;
    user.inviteExpires = invite.expires;
  }
  await user.save();
  if (account) await syncAccount(account, user, { password });

  const mail = invite ? await emailInvite(user, invite.url, true)
    : password && emailPassword ? await emailWelcome(user, password, true) : null;
  return { user: publicUser(user), setPasswordUrl: invite?.url ?? null, mail };
}

/**
 * The partner's Mariox One account follows the profile: name, email, status (signing out everywhere
 * when suspended) and a password set by the admin (also signs out everywhere).
 */
async function syncAccount(account, profile, { password }) {
  const status = PORTAL_STATUS[profile.status];
  await User.updateOne({ id: account.id }, { name: profile.name, email: profile.email, status });
  if (status === 'Deactivated' && account.status !== 'Deactivated') await revokeSessions(account.id);
  if (password) await replacePassword(account.id, password);
}

/**
 * Deletes a partner with their Mariox One account, leads, requests and uploaded files. Refused for
 * yourself and while they have projects (those hold payment and commission records). Deleting a
 * partner-admin profile only unlinks it from its staff account (it is recreated on their next visit).
 */
export async function remove(me, id) {
  if (id === me.sub) throw new PpError(400, "You can't delete your own account");
  const profile = await find(id);
  const projects = await PpProject.countDocuments({ owner: id });
  if (projects) throw new PpError(409, `This partner has ${projects} project(s) with payment records. Suspend them instead, or delete the projects first.`);

  const account = await portalUserOf(id, '_id');
  const keys = (await PpFile.find({ owner: id }).select('key').lean()).map((f) => f.key);
  await tx(async (session) => {
    for (const m of [PpLead, PpScope, PpBooking, PpTechRequest, PpTicket, PpFile]) await m.deleteMany({ owner: id }, { session });
    await PpUser.deleteOne({ _id: id }, { session });
    if (account && profile.role === 'partner') await removeUser(account.id, session);
    else if (account) await User.updateOne({ id: account.id }, { pp_user_id: null }, { session });
  });
  // Stored objects go after the commit (storage is not transactional); a failure only leaves orphans.
  await storage.remove(keys).catch(() => {});
}
