import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../../../config/index.js';
import { nextId } from '../../../core/ids.js';
import { CASE_INSENSITIVE } from '../../../db/modelKit.js';
import { PpUser, User } from '../../../db/models/index.js';
import { PARTNER_ROLE } from '../../../db/models/roles.js';
import { tx } from '../../../db/mongo.js';
import { nextCode, withFreshCode } from './codes.js';
import { PARTNER_CODE_PREFIX, portalUrl } from './constants.js';
import { partnerInvite, partnerWelcome } from './emails.js';
import { PpError } from './http.js';
import { sendMail } from './mail.js';
import { R, zPhone, zs, zUpper } from './validate.js';

/**
 * Partner accounts (mariox-saas src/lib/users.ts). A partner is two linked records (docs/SSO.md): the
 * `pp_users` partner profile (code, company, payout details, rate) and the Mariox One portal user
 * that signs in (role Partner, `users.pp_user_id`), which holds the password and sessions.
 */

/** New partner: admin panel, main-site API and acquisition all use the same rules. */
export const newPartnerSchema = z.object({
  name: zs(R.person, true, 80),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128).optional(),
  phone: zPhone(),
  company: zs(R.company, false, 120),
  city: zs(R.city, false, 60),
  industries: zs(R.tags, false, 200),
  externalId: z.string().optional(),
  commissionRate: z.number().min(0).max(1).optional(),
});

/** Contact and payout details a partner (or an admin for them) can edit. Codes are stored in capitals. */
export const profileFields = {
  name: zs(R.person, true, 80).optional(),
  phone: zPhone(),
  company: zs(R.company, false, 120),
  city: zs(R.city, false, 60),
  industries: zs(R.tags, false, 200),
  pan: zUpper(R.pan),
  gstin: zUpper(R.gstin),
  bankAccount: zs(R.bankAccount, false, 18),
  ifsc: zUpper(R.ifsc),
};

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Portal statuses of a partner's account ↔ its profile's status. */
export const PORTAL_STATUS = { invited: 'Invited', active: 'Active', disabled: 'Deactivated' };

/** The portal user that signs in for a pp_users profile (or null). */
export const portalUserOf = (ppUserId, fields = 'name email status role_id', session = null) =>
  User.findOne({ pp_user_id: String(ppUserId) }).select(fields).session(session).rows();

/** Is the email taken by any profile or portal account (other than the portal account `exceptUserId`)? */
export async function emailTaken(email, { exceptPpUserId, exceptUserId } = {}, session = null) {
  const pp = await PpUser.exists({ email: email.toLowerCase(), ...(exceptPpUserId ? { _id: { $ne: exceptPpUserId } } : {}) }).session(session);
  if (pp) return true;
  const portal = await User.exists({ email: email.trim(), ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}) })
    .collation(CASE_INSENSITIVE).session(session);
  return !!portal;
}

const INVITE_DAYS = 7;
/** A fresh one-time set-password token → { token, hash, expires, url }. */
export function newInvite() {
  const token = crypto.randomBytes(24).toString('hex');
  return { token, hash: hashToken(token), expires: new Date(Date.now() + INVITE_DAYS * 864e5), url: `${portalUrl(config.appUrl)}/set-password?token=${token}` };
}

/**
 * A profile as the API returns it: no secrets, plus a string `id`. Profiles from before the one
 * login may still carry their old `passwordHash` / `sessionVersion`; those never leave the server.
 */
export function publicUser(u) {
  if (!u) return u;
  const o = typeof u.toObject === 'function' ? u.toObject() : u;
  const SECRET_FIELDS = ['passwordHash', 'sessionVersion', 'inviteToken', 'inviteExpires', '__v', 'resetOtpHash', 'resetOtpExpires',
    'resetOtpSentAt', 'resetOtpAttempts', 'resetTokenHash', 'resetTokenExpires'];
  const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !SECRET_FIELDS.includes(k)));
  return { ...rest, id: String(o._id) };
}

/**
 * Creates a partner: the profile with the next partner ID (MX-P-243-<n>) and its portal account
 * (role Partner). Without a password both are "invited" and a one-time set-password link (7 days)
 * comes back; with one they are active straight away.
 * @param {import('mongoose').ClientSession | null} [session] the caller's transaction, if any
 * @returns {Promise<{ user: object, setPasswordUrl: string | null }>}
 */
export async function createPartner(input, source, session = null) {
  const email = input.email.toLowerCase();
  if (await emailTaken(email, {}, session)) throw new PpError(409, 'A user with this email already exists');

  const { password, ...rest } = input;
  const invite = password ? null : newInvite();
  const passwordHash = password ? await bcrypt.hash(password, config.bcryptRounds) : null;
  const create = async (s) => {
    const profile = await withFreshCode(
      () => nextCode(PpUser, 'partnerCode', PARTNER_CODE_PREFIX, 0, 1),
      (partnerCode) => new PpUser({
        ...rest,
        email,
        role: 'partner',
        source,
        partnerCode,
        status: password ? 'active' : 'invited',
        inviteToken: invite?.hash,
        inviteExpires: invite?.expires,
      }).save({ session: s }),
      'partnerCode',
    );
    await User.insertMany([{
      id: await nextId('user'),
      name: profile.name,
      email,
      phone: profile.phone || '',
      title: 'Partner',
      role_id: PARTNER_ROLE,
      status: password ? 'Active' : 'Invited',
      invited_at: new Date(),
      password_hash: passwordHash,
      pp_user_id: String(profile._id),
    }], { session: s });
    return profile;
  };
  const profile = session ? await create(session) : await tx(create);
  return { user: publicUser(profile), setPasswordUrl: invite?.url ?? null };
}

/** Emails the set-password link; `{ sent, to, error? }`, never throws. */
export const emailInvite = (user, url, again = false) =>
  sendMail({ to: user.email, ...partnerInvite({ name: user.name, email: user.email, partnerCode: user.partnerCode, url, again }) });

/** Emails the portal link with the email and password the admin set; `{ sent, to, error? }`, never throws. */
export const emailWelcome = (user, password, reset = false) =>
  sendMail({ to: user.email, ...partnerWelcome({ name: user.name, email: user.email, partnerCode: user.partnerCode, password, loginUrl: `${portalUrl(config.appUrl)}/login`, reset }) });
