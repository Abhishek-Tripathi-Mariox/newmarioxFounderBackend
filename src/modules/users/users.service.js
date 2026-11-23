import bcrypt from 'bcryptjs';
import { tx } from '../../db/mongo.js';
import { CASE_INSENSITIVE } from '../../db/modelKit.js';
import { Member, PpUser, Role, SalesOwner, User } from '../../db/models/index.js';
import { PARTNER_ROLE, SUPER_ROLE } from '../../db/models/roles.js';
import { HQ_SEAT_LABELS } from '../../db/models/users.js';
import { config } from '../../config/index.js';
import { nextId } from '../../core/ids.js';
import { audit } from '../../core/audit.js';
import { pageParams, sortParam } from '../../core/http.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { newInvite, newReset } from '../auth/oneTime.js';
import { revokeSessions } from '../auth/auth.service.js';
import { sendMail } from '../../core/mailer.js';
import { inviteEmail, resetEmail } from './users.emails.js';
import * as repo from './users.repository.js';
import { toUserDto } from './users.mapper.js';
import { newOwnerId } from '../people/founderOwners.js';

/** Roles that become delivery members (Team & hours, timesheets) — same as the frontend. */
export const DELIVERY_ROLES = ['r-pm', 'r-tl', 'r-tm', 'r-qa'];
/** Roles that own leads / follow-ups. */
export const SALES_ROLES = ['r-sm', 'r-se'];
/** Built-in roles that are never delivery members. */
const NON_DELIVERY = ['r-super', 'r-admin', 'r-sm', 'r-se', 'r-client', PARTNER_ROLE];

/**
 * Does this role make someone a delivery member (Team & hours, project / milestone pickers)?
 * Built-in PM / Team Lead / Team Member / QA always do; a custom role (e.g. "Developer") does when
 * it can see timesheets, tasks or bugs.
 */
export function isDeliveryRole(role) {
  if (!role) return false;
  if (DELIVERY_ROLES.includes(role.id)) return true;
  if (NON_DELIVERY.includes(role.id)) return false;
  const p = role.perms || {};
  return !!((p.ts && p.ts.v) || (p.tasks && p.tasks.v) || (p.bugs && p.bugs.v));
}
export const TEAMS = ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];

/** True when `id` is the only active Super Admin left — that account can't lose access, or nobody could manage the portal. */
async function isLastSuperAdmin(id, session = null) {
  const u = await User.findOne({ id }).select('role_id status').session(session).rows();
  if (!u || u.role_id !== SUPER_ROLE || u.status !== 'Active') return false;
  const others = await User.countDocuments({ role_id: SUPER_ROLE, status: 'Active', _id: { $ne: id } }).session(session);
  return others === 0;
}

const randomHue = () => Math.floor(Math.random() * 360);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** ?sort= keys → fields of the users ⋈ roles rows (users.repository page()). */
const SORTS = { name: 'name', email: 'email', role: 'role_name', dept: 'dept', status: 'status', lastActiveAt: 'last_active_at', joinDate: 'join_date', createdAt: 'created_at' };

export async function list(query) {
  const p = pageParams(query);
  const filter = repo.filterOf(query);
  // Default order like the frontend: Active → Invited → Deactivated, then name.
  const [total, rows] = await Promise.all([repo.count(filter), repo.page(filter, sortParam(query.sort, SORTS, null), p)]);
  return { rows: rows.map(toUserDto), meta: p.meta(total) };
}

async function getRow(id, session = null) {
  const u = await repo.findById(id, session);
  if (!u) throw notFound('User');
  return u;
}
export const get = async (id) => toUserDto(await getRow(id));

const roleById = (id, session = null) => Role.findOne({ id }).select('name perms').session(session).rows();

/** Only a Super Admin may grant the Super Admin role or change a Super Admin account. */
function guardSuper(req, ...roleIds) {
  if (!req.user.isSuper && roleIds.includes('r-super')) throw forbidden('Only a Super Admin can manage Super Admin accounts');
}

/**
 * Partner accounts belong to Mariox Partners (created by its invite, linked to a partner profile):
 * Users & roles can't create them or move people into / out of the Partner role.
 */
function guardPartnerRole(newRole, oldRole = null) {
  if ((newRole === PARTNER_ROLE || oldRole === PARTNER_ROLE) && newRole !== oldRole) {
    throw unprocessable('Partner accounts are managed in Mariox Partners.');
  }
}

/** Founders HQ access (docs/SSO.md): only a Super Admin sets it, never on client / partner accounts, one person per seat. */
async function checkHqSeat(req, m, old, session) {
  const before = old?.hq_seat ?? null;
  if (m.hqSeat === before) return;
  if (!req.user.isSuper) throw forbidden('Only a Super Admin can change Founders HQ access');
  if (!m.hqSeat) return;
  if (m.role === 'r-client' || m.role === PARTNER_ROLE) throw unprocessable('Clients and partners can’t have Founders HQ access.');
  const holder = await User.findOne({ hq_seat: m.hqSeat, ...(old ? { _id: { $ne: old.id } } : {}) }).select('name').session(session).rows();
  if (holder) throw unprocessable(`The ${HQ_SEAT_LABELS[m.hqSeat]} seat is already taken by ${holder.name}.`);
}

/** Same checks and messages as the frontend saveUser(). */
async function validateForm(m, editId, session) {
  if (!m.name || !m.name.trim()) throw unprocessable('Enter the person’s name.');
  if (!EMAIL_RE.test((m.email || '').trim())) throw unprocessable('Enter a valid work email.');
  const dupFilter = { email: m.email.trim(), ...(editId ? { _id: { $ne: editId } } : {}) };
  const dup = await User.findOne(dupFilter).collation(CASE_INSENSITIVE).select('_id').session(session).rows();
  if (dup) throw unprocessable('Someone already uses this email.');
  const role = await roleById(m.role, session);
  if (!role) throw unprocessable('Pick a role.');
  if (m.reportsTo) {
    if (m.reportsTo === editId) throw unprocessable('Someone can’t report to themselves.');
    if (!(await User.exists({ id: m.reportsTo }).session(session))) throw unprocessable('Pick who they report to.');
  }
  return role;
}

/**
 * Keep the linked delivery member / sales owner in step with the user (frontend saveUser):
 * delivery roles get a members row, sales roles and seat holders a sales_owners row.
 */
async function syncPeople(session, m, role, old) {
  const delivery = isDeliveryRole(role);
  const team = TEAMS.includes(m.dept) ? m.dept : 'Web';
  let memberId = old ? old.member_id : null;
  let ownerId = old ? old.owner_id : null;
  if (delivery && !memberId) {
    memberId = await nextId('member');
    await Member.insertMany([{ id: memberId, name: m.name, role_title: m.title || role.name, team, hue: m.hue ?? randomHue(), shift_hours: m.shiftHours }], { session });
  } else if (memberId) {
    await Member.updateOne({ id: memberId }, {
      name: m.name, shift_hours: m.shiftHours, ...(m.title ? { role_title: m.title } : {}), ...(delivery ? { team } : {}),
    }, { session });
  }
  // Sales roles own leads; so do the Founder / Co-founder (an HQ seat), whose profile isn't sales staff
  // (modules/people/founderOwners.js).
  const sales = SALES_ROLES.includes(m.role);
  if ((sales || m.hqSeat) && !ownerId) {
    ownerId = await newOwnerId();
    await SalesOwner.insertMany([{ id: ownerId, name: m.name, hue: m.hue ?? randomHue(), founder: !sales }], { session });
  } else if (ownerId) {
    await SalesOwner.updateOne({ id: ownerId }, { name: m.name }, { session });
  }
  return { memberId, ownerId };
}

const norm = (b, prev = {}) => ({
  name: (b.name ?? prev.name ?? '').trim(),
  email: (b.email ?? prev.email ?? '').trim(),
  phone: b.phone ?? prev.phone ?? '',
  title: (b.title ?? prev.title ?? '').trim(),
  role: b.role ?? prev.role_id,
  dept: b.dept ?? prev.dept ?? '',
  reportsTo: b.reportsTo !== undefined ? b.reportsTo : prev.reports_to ?? null,
  joinDate: b.joinDate !== undefined ? b.joinDate : prev.join_date ?? null,
  shiftHours: b.shiftHours ?? (prev.shift_hours != null ? Number(prev.shift_hours) : 8),
  clientOf: b.clientOf ?? prev.client_of ?? [],
  hqSeat: b.hq_seat !== undefined ? b.hq_seat : prev.hq_seat ?? null,
  hue: prev.hue,
});

const userCols = (m) => ({
  name: m.name, email: m.email, phone: m.phone, title: m.title, role_id: m.role, dept: m.dept, reports_to: m.reportsTo,
  join_date: m.joinDate, shift_hours: m.shiftHours, client_of: m.role === 'r-client' ? m.clientOf : [], hq_seat: m.hqSeat,
});

/**
 * Email a one-time link (invite or set-password). When the email went out the raw token is NOT returned
 * (only the recipient can use it); if email isn't configured or sending failed, the token is returned
 * once so the admin can share the link by hand.
 */
async function deliverLink(kind, { name, email, roleName, invitedBy }, tok) {
  const msg = kind === 'invite'
    ? inviteEmail({ name, email, roleName, invitedBy, token: tok.token })
    : resetEmail({ name, email, token: tok.token });
  const emailSent = await sendMail(msg);
  const field = kind === 'invite' ? 'invite' : 'reset';
  return emailSent
    ? { emailSent, [`${field}ExpiresAt`]: tok.expiresAt.toISOString() }
    : { emailSent, [`${field}Token`]: tok.token, [`${field}ExpiresAt`]: tok.expiresAt.toISOString() };
}

/** Invite (status Invited + one-time invite token, emailed) or add an Active user. */
export async function create(req, body) {
  const m = norm(body);
  guardSuper(req, m.role);
  guardPartnerRole(m.role);
  const out = await tx(async (session) => {
    const role = await validateForm(m, null, session);
    await checkHqSeat(req, m, null, session);
    const id = await nextId('user');
    const hue = randomHue();
    const { memberId, ownerId } = await syncPeople(session, { ...m, hue }, role, null);
    const invite = body.sendInvite ? newInvite() : null;
    const reset = !body.sendInvite && !body.password ? newReset() : null;
    await User.insertMany([{
      id, ...userCols(m), hue, status: body.sendInvite ? 'Invited' : 'Active', invited_at: new Date(), member_id: memberId, owner_id: ownerId,
      password_hash: !body.sendInvite && body.password ? await bcrypt.hash(body.password, config.bcryptRounds) : null,
      invite_token_hash: invite?.hash ?? null, invite_expires_at: invite?.expiresAt ?? null,
      reset_token_hash: reset?.hash ?? null, reset_expires_at: reset?.expiresAt ?? null,
    }], { session });
    await audit(req, `${body.sendInvite ? 'invited ' : 'added '}${m.name} as ${role.name}`, 'Invite', session);
    return { id, invite, reset, roleName: role.name };
  });
  const user = await get(out.id);
  const who = { name: m.name, email: m.email.trim(), roleName: out.roleName, invitedBy: req.actor.name };
  if (out.invite) return { ...user, ...(await deliverLink('invite', who, out.invite)) };
  if (out.reset) return { ...user, ...(await deliverLink('reset', who, out.reset)) };
  return user;
}

export async function update(req, id, body) {
  await tx(async (session) => {
    const old = await User.findOne({ id }).session(session).rows();
    if (!old) throw notFound('User');
    const m = norm(body, old);
    guardSuper(req, old.role_id, m.role);
    if (id === req.actor.id && m.role !== old.role_id && !req.actor.isSuper) throw forbidden('You can’t change your own role.');
    if (m.role !== old.role_id && await isLastSuperAdmin(id, session)) throw unprocessable('The last Super Admin’s role can’t be changed.');
    guardPartnerRole(m.role, old.role_id);
    const role = await validateForm(m, id, session);
    await checkHqSeat(req, m, old, session);
    const { memberId, ownerId } = await syncPeople(session, m, role, old);
    await User.updateOne({ id }, { ...userCols(m), member_id: memberId, owner_id: ownerId }, { session });
    // The Mariox Partners profile shows the account's name and email.
    if (old.pp_user_id && (m.name !== old.name || m.email !== old.email)) {
      await PpUser.updateOne({ _id: old.pp_user_id }, { $set: { name: m.name, email: m.email.toLowerCase() } }, { session });
    }
    if (old.role_id !== m.role) {
      const from = await roleById(old.role_id, session);
      await audit(req, `changed ${m.name} from ${from ? from.name : old.role_id} to ${role.name}`, 'Role', session);
    } else {
      await audit(req, `updated ${m.name}’s profile`, 'Profile', session);
    }
  });
  return get(id);
}

/**
 * A user's linked delivery member / sales owner follows the account: inactive accounts drop off Live,
 * attendance and pickers. A linked Mariox Partners profile is suspended / reactivated with it.
 */
async function setPersonActive(session, u, active) {
  if (u.member_id) await Member.updateOne({ id: u.member_id }, { active }, { session });
  if (u.owner_id) await SalesOwner.updateOne({ id: u.owner_id }, { active }, { session });
  if (u.pp_user_id) await PpUser.updateOne({ _id: u.pp_user_id }, { $set: { status: active ? 'active' : 'disabled' } }, { session });
}

/** Load a user for an admin action, refusing the last Super Admin / yourself where it matters. */
async function target(req, id, { what, protect = false } = {}) {
  const u = await getRow(id);
  guardSuper(req, u.role_id);
  if (protect && await isLastSuperAdmin(id)) throw unprocessable(`The last Super Admin can’t be ${what}.`);
  if (protect && id === req.actor.id) throw unprocessable(`You can’t ${what === 'deleted' ? 'delete' : 'deactivate'} your own account.`);
  return u;
}

export async function setStatus(req, id, status) {
  const u = await target(req, id, { what: 'deactivated', protect: status === 'Deactivated' });
  if (status === 'Deactivated' && u.status === 'Deactivated') throw unprocessable(`${u.name} is already deactivated.`);
  if (status === 'Active' && u.status !== 'Deactivated') throw unprocessable(`${u.name} isn’t deactivated.`);
  await tx(async (session) => {
    await User.updateOne({ id }, { status }, { session });
    await setPersonActive(session, u, status === 'Active');
    if (status === 'Deactivated') await revokeSessions(id, session);
    await audit(req, `${status === 'Deactivated' ? 'deactivated ' : 'reactivated '}${u.name}`, 'Access', session);
  });
  return get(id);
}

/** Delete a user or cancel an invite. Active users must be deactivated first. */
export async function remove(req, id) {
  const u = await target(req, id, { what: 'deleted', protect: true });
  if (u.status === 'Active') throw unprocessable('Deactivate this user before deleting them.');
  // A partner goes with their partner profile, leads and files: Mariox Partners deletes both.
  if (u.role_id === PARTNER_ROLE) throw unprocessable('Delete partners in Mariox Partners → Partners.');
  await tx(async (session) => {
    // Keep the member / sales-owner row (time logs and leads reference it) but take it off
    // Live now, attendance and dropdowns.
    await setPersonActive(session, u, false);
    // A partner-admin profile belongs to this person only.
    if (u.pp_user_id) await PpUser.deleteOne({ _id: u.pp_user_id, role: 'admin' }, { session });
    await repo.removeUser(id, session);
    await audit(req, `${u.status === 'Invited' ? 'cancelled the invite for ' : 'deleted '}${u.name}`, 'Access', session);
  });
}

/** New invite token (the old one stops working). */
export async function resendInvite(req, id) {
  const u = await target(req, id);
  if (u.status !== 'Invited') throw unprocessable(`${u.name} has already accepted their invite.`);
  const inv = newInvite();
  await tx(async (session) => {
    await User.updateOne({ id }, { invite_token_hash: inv.hash, invite_expires_at: inv.expiresAt, invited_at: new Date() }, { session });
    await audit(req, `resent the invite to ${u.name}`, 'Invite', session);
  });
  const role = await roleById(u.role_id);
  return { id, email: u.email, ...(await deliverLink('invite', { name: u.name, email: u.email, roleName: role?.name, invitedBy: req.actor.name }, inv)) };
}

/** One-time password reset token (used at POST /auth/reset-password). */
export async function resetPassword(req, id) {
  const u = await target(req, id);
  if (u.status === 'Invited') throw unprocessable(`${u.name} hasn’t accepted their invite yet — resend the invite instead.`);
  if (u.status === 'Deactivated') throw unprocessable(`${u.name} is deactivated — reactivate them first.`);
  const r = newReset();
  await tx(async (session) => {
    await User.updateOne({ id }, { reset_token_hash: r.hash, reset_expires_at: r.expiresAt }, { session });
    await audit(req, `sent a password reset to ${u.name}`, 'Access', session);
  });
  return { id, email: u.email, ...(await deliverLink('reset', { name: u.name, email: u.email }, r)) };
}

/** Revoke every refresh token (access tokens still expire on their own within their short TTL). */
export async function forceLogout(req, id) {
  const u = await target(req, id);
  const revoked = await tx(async (session) => {
    const n = await revokeSessions(id, session);
    await audit(req, `signed ${u.name} out of all devices`, 'Access', session);
    return n;
  });
  return { id, revokedSessions: revoked };
}
