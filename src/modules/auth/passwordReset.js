import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { AppError } from '../../core/errors.js';
import { esc, layout } from '../../core/emailLayout.js';
import { logger } from '../../core/logger.js';
import { mailEnabled, sendMail } from '../../core/mailer.js';
import { hashToken } from '../../core/tokens.js';
import { CASE_INSENSITIVE } from '../../db/modelKit.js';
import { AuditLog, PasswordReset, User } from '../../db/models/index.js';
import { replacePassword } from './auth.service.js';

/**
 * Self-service "forgot password" for every account (team, founders, clients, partners), from the
 * sign-in page: POST /auth/forgot → 6-digit code by email; /auth/forgot/verify → single-use reset
 * token; /auth/forgot/reset → new password, signed out everywhere. Mariox Partners' /pp/auth/forgot*
 * use the same functions (docs/SSO.md).
 *
 * No account enumeration: unknown, Invited and Deactivated addresses get exactly the same answers
 * (a decoy reset document with a code that is never sent), and only Active accounts can reset.
 */

export const OTP_MINUTES = 10;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const RESET_TOKEN_MINUTES = 15;
/** How long a reset document is kept after its last use (cooldown/attempt state); TTL-deleted after. */
const KEEP_MINUTES = 60;

export const CODE_EXPIRED = 'This code has expired. Ask for a new one.';
export const TOO_MANY = 'Too many wrong codes. Ask for a new one.';
export const RESET_EXPIRED = 'This reset has expired. Start again.';

const fail = (status, message) => new AppError(status, status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message);
const keyOf = (email) => hashToken(String(email).trim().toLowerCase());
const otpHash = (key, code) => hashToken(`${key}:${code}`);
const newOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const minutesFromNow = (m) => new Date(Date.now() + m * 6e4);
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

/** The account a reset may change: Active only (Invited / Deactivated / unknown → null). */
async function activeUser(where) {
  const u = await User.findOne(where).collation(CASE_INSENSITIVE).select('name email status').rows();
  return u && u.status === 'Active' ? u : null;
}

export function codeEmail({ name, code }) {
  const org = config.mail.from.name;
  const note = `The code expires in ${OTP_MINUTES} minutes and works once. Never share it: ${org} will never ask you for it.`;
  return {
    subject: `${code} is your Mariox password reset code`,
    text: `Hi ${firstName(name)},\n\nYour ${org} password reset code: ${code}\n${note}\n\nDidn't ask for this? Ignore this email: your password stays the same.\n`,
    html: layout({
      heading: 'Your password reset code',
      intro: `Hi ${esc(firstName(name))},<br>Enter this code on the ${esc(org)} sign-in page to set a new password.`,
      body: `<div style="margin:0 0 20px;padding:18px 12px;border-radius:10px;background:#f4f5f8;text-align:center;font:700 32px 'Courier New',monospace;letter-spacing:10px;color:#1f2330">${esc(code)}</div>`,
      note,
      footer: "Didn't ask for this? You can ignore this email: your password stays the same.",
    }),
  };
}

export function changedEmail({ name }) {
  const org = config.mail.from.name;
  const link = `${config.appUrl}/login`;
  return {
    subject: `Your ${org} password was changed`,
    text: `Hi ${firstName(name)},\n\nThe password of your ${org} account was just changed with a reset code, and every device was signed out.\nSign in: ${link}\n\nIf this wasn't you, contact your admin straight away.\n`,
    html: layout({
      heading: 'Your password was changed',
      intro: `Hi ${esc(firstName(name))},<br>The password of your ${esc(org)} account was just changed with an emailed reset code. Every device was signed out.`,
      button: 'Sign in',
      link,
      note: "If this wasn't you, contact your admin straight away.",
      footer: '',
    }),
  };
}

/**
 * Get the code to the person: by email when mail is set up. Without email outside production the
 * code goes to the server log (dev only) so local testing works; in production it is never logged.
 */
export async function deliverCode(user, code, { isProd = config.isProd, mailOn = mailEnabled(), log = logger } = {}) {
  if (mailOn) {
    const sent = await sendMail({ to: user.email, ...codeEmail({ name: user.name, code }) });
    if (!sent) log.error({ userId: user.id }, 'Password reset: the code email could not be sent');
    return sent;
  }
  if (isProd) {
    log.error({ userId: user.id }, 'Password reset requested but email is not configured (SMTP_USER / SMTP_PASS): no code was sent');
    return false;
  }
  log.warn(`[DEV ONLY, email not configured] password reset code for ${user.email}: ${code} (valid ${OTP_MINUTES} min)`);
  return false;
}

/**
 * Step 1. Same answer for every address. A new code at most every 60 s per address (429 with the
 * wait otherwise — also for unknown addresses, so the cooldown reveals nothing).
 */
export async function requestCode(email) {
  const key = keyOf(email);
  const user = await activeUser({ email: String(email).trim() });
  const code = newOtp();
  const now = new Date();
  const set = {
    user_id: user ? user.id : null, otp_hash: otpHash(key, code), otp_expires_at: minutesFromNow(OTP_MINUTES),
    sent_at: now, attempts: 0, token_hash: null, token_expires_at: null, purge_at: minutesFromNow(KEEP_MINUTES),
  };
  try {
    // Claimed only when no code was sent in the last 60 s; otherwise the upsert hits the _id index.
    await PasswordReset.findOneAndUpdate(
      { _id: key, sent_at: { $lte: new Date(now.getTime() - OTP_RESEND_SECONDS * 1000) } },
      { $set: set },
      { upsert: true },
    );
  } catch (e) {
    if (e?.code !== 11000) throw e;
    const row = await PasswordReset.findById(key).select('sent_at').lean();
    const wait = row ? Math.max(1, Math.ceil(OTP_RESEND_SECONDS - (Date.now() - row.sent_at.getTime()) / 1000)) : 1;
    throw fail(429, `Please wait ${wait} seconds before asking for a new code`);
  }
  if (user) await deliverCode(user, code);
  return { sent: true, expiresIn: OTP_MINUTES * 60, resendIn: OTP_RESEND_SECONDS };
}

/** Step 2. Every guess uses one of 5 tries (atomically); the right code becomes a 15-minute reset token. */
export async function verifyCode(email, code) {
  const key = keyOf(email);
  const now = new Date();
  const row = await PasswordReset.findOneAndUpdate(
    { _id: key, otp_hash: { $type: 'string' }, otp_expires_at: { $gt: now }, attempts: { $lt: OTP_MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true },
  ).lean();
  if (!row) {
    const current = await PasswordReset.findById(key).select('otp_hash otp_expires_at attempts').lean();
    const live = current?.otp_hash && current.otp_expires_at > now;
    if (live && current.attempts >= OTP_MAX_ATTEMPTS) throw fail(429, TOO_MANY);
    throw fail(400, CODE_EXPIRED);
  }
  if (!same(otpHash(key, String(code).trim()), row.otp_hash)) {
    const left = OTP_MAX_ATTEMPTS - row.attempts;
    throw fail(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : TOO_MANY);
  }
  const token = crypto.randomBytes(24).toString('hex');
  // The code works once: of two concurrent right answers only one gets a token.
  const claimed = await PasswordReset.updateOne(
    { _id: key, otp_hash: row.otp_hash },
    { $set: { otp_hash: null, otp_expires_at: null, attempts: 0, token_hash: hashToken(token), token_expires_at: minutesFromNow(RESET_TOKEN_MINUTES), purge_at: minutesFromNow(KEEP_MINUTES) } },
  );
  if (!claimed.modifiedCount) throw fail(400, CODE_EXPIRED);
  return { token };
}

/**
 * Step 3. The token works once. Sets the password, signs the account out everywhere, writes the
 * activity log and tells the person by email. `email` (optional, the partner app sends it) must
 * match the address the code was sent to.
 */
export async function resetPassword({ token, password, email }) {
  const row = await PasswordReset.findOne({ token_hash: hashToken(String(token)) }).lean();
  if (!row || !row.token_expires_at || row.token_expires_at <= new Date() || (email != null && keyOf(email) !== row._id)) {
    throw fail(400, RESET_EXPIRED);
  }
  const used = await PasswordReset.deleteOne({ _id: row._id, token_hash: row.token_hash });
  if (!used.deletedCount) throw fail(400, RESET_EXPIRED);
  const user = row.user_id && await activeUser({ id: row.user_id });
  if (!user) throw fail(400, RESET_EXPIRED);

  await replacePassword(user.id, password);
  await AuditLog.insertMany([{ actor_user_id: user.id, actor_name: user.name, text: `${user.name} reset their password with an emailed code`, kind: 'Credentials' }]);
  if (mailEnabled()) await sendMail({ to: user.email, ...changedEmail({ name: user.name }) });
  return { ok: true };
}
