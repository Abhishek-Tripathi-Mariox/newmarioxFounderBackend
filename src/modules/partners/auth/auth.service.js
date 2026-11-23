import { PpUser } from '../../../db/models/index.js';
import { issueSession, replacePassword } from '../../auth/auth.service.js';
import { PpError } from '../lib/http.js';
import { hashToken, portalUserOf, publicUser } from '../lib/users.js';

/**
 * Invite completion of the partner app (mariox-saas src/app/api/auth/**). Sign-in itself is the one
 * Mariox One login and forgot-password is the one portal flow (modules/auth/passwordReset.js, see
 * the controller); both set the password of the portal account linked to the partner profile.
 */

const INVALID_LINK = 'This link is invalid or has expired';
/** Setting a password also activates an account that was still waiting for it. */
const activating = (portalUser) => (portalUser.status === 'Invited' ? { status: 'Active', invite_token_hash: null, invite_expires_at: null } : {});

/**
 * Completes an invite: sets the portal password, activates the account and signs it in.
 * @returns {{ user: object, session: { accessToken, refreshToken } | null }} no session when the account is deactivated
 */
export async function setPassword({ token, password }, meta) {
  const tokenHash = hashToken(token);
  const profile = await PpUser.findOne({ inviteToken: tokenHash, inviteExpires: { $gt: new Date() } }).select('_id').lean();
  const portalUser = profile && await portalUserOf(profile._id, 'status');
  if (!portalUser) throw new PpError(400, INVALID_LINK);
  // Claim the one-time link atomically: of two concurrent submits only one sets the password.
  const claimed = await PpUser.findOneAndUpdate(
    { _id: profile._id, inviteToken: tokenHash },
    [{ $set: { status: { $cond: [{ $eq: ['$status', 'invited'] }, 'active', '$status'] } } }, { $unset: ['inviteToken', 'inviteExpires'] }],
    { new: true },
  );
  if (!claimed) throw new PpError(400, INVALID_LINK);
  const extra = activating(portalUser);
  await replacePassword(portalUser.id, password, extra);
  const active = (extra.status || portalUser.status) === 'Active';
  return { user: publicUser(claimed), session: active ? await issueSession(portalUser.id, meta) : null };
}
