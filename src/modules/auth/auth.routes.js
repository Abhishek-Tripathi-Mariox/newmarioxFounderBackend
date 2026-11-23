import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter, passwordResetLimiter } from '../../middleware/rateLimit.js';
import * as s from './auth.schemas.js';
import * as ctrl from './auth.controller.js';

const router = Router();

// Public
router.post('/login', loginLimiter, validate({ body: s.loginSchema }), ctrl.login);
router.post('/refresh', validate({ body: s.refreshSchema }), ctrl.refresh);
router.post('/logout', validate({ body: s.refreshSchema }), ctrl.logout);
router.post('/accept-invite', loginLimiter, validate({ body: s.acceptInviteSchema }), ctrl.acceptInvite);
router.post('/reset-password', loginLimiter, validate({ body: s.resetPasswordSchema }), ctrl.resetPassword);
// Forgot password, for every account (code by email → token → new password)
router.post('/forgot', passwordResetLimiter, validate({ body: s.forgotSchema }), ctrl.forgot);
router.post('/forgot/verify', passwordResetLimiter, validate({ body: s.forgotVerifySchema }), ctrl.forgotVerify);
router.post('/forgot/reset', passwordResetLimiter, validate({ body: s.forgotResetSchema }), ctrl.forgotReset);

// Signed in
router.get('/me', authenticate, ctrl.me);
router.post('/change-password', authenticate, validate({ body: s.changePasswordSchema }), ctrl.changePassword);

export default router;
