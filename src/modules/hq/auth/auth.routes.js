import { Router } from 'express';
import { noContent, ok } from '../../../core/http.js';
import { clearRefreshCookie, REFRESH_COOKIE, sessionMeta, setRefreshCookie } from '../../../core/tokens.js';
import { User } from '../../../db/models/index.js';
import { isCurrentPassword, issueSession, logout, replacePassword } from '../../auth/auth.service.js';
import { authenticateHq } from '../core/authenticate.js';
import { badRequest } from '../core/errors.js';
import { validate } from '../core/validate.js';
import { toUserDTO } from '../users/users.mapper.js';
import { changePasswordBody } from './auth.schemas.js';

/**
 * /hq/auth — the signed-in founder. Sign-in is the one Mariox One login (POST /api/v1/auth/login,
 * docs/SSO.md); /logout is the portal sign-out and the password is the portal password.
 */
export function createAuthRouter() {
  const router = Router();

  router.get('/me', authenticateHq, async (req, res) => {
    const account = await User.findOne({ id: req.actor.id }).select('name email last_active_at hq_role').rows();
    ok(res, { user: toUserDTO(req.hqUser, account) });
  });
  router.post('/logout', async (req, res) => {
    await logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    noContent(res);
  });
  router.post('/change-password', authenticateHq, validate({ body: changePasswordBody }), async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;
    if (!(await isCurrentPassword(req.actor.id, currentPassword))) throw badRequest('Your current password is not right.');
    // Every session ends; this device gets a fresh one.
    await replacePassword(req.actor.id, newPassword);
    setRefreshCookie(res, (await issueSession(req.actor.id, sessionMeta(req))).refreshToken);
    noContent(res);
  });

  return router;
}
