import { Router } from 'express';
import { ppPasswordResetLimiter } from '../../../middleware/rateLimit.js';
import * as ctrl from './auth.controller.js';

/**
 * /pp/auth — public: sign out, complete an invite, forgot password (code → verify → reset). Sign-in is
 * the one Mariox One login (POST /api/v1/auth/login, docs/SSO.md); /logout is the portal sign-out.
 */
const router = Router();
router.post('/logout', ctrl.logout);
router.post('/set-password', ctrl.setPassword);
router.post('/forgot', ppPasswordResetLimiter, ctrl.forgot);
router.post('/forgot/verify', ppPasswordResetLimiter, ctrl.forgotVerify);
router.post('/forgot/reset', ppPasswordResetLimiter, ctrl.forgotReset);
export default router;
