import { Router } from 'express';
import { requireSession } from '../lib/session.js';
import * as ctrl from './me.controller.js';

/** /pp/me — own profile, password and sessions. */
const router = Router();
router.use(requireSession);
router.get('/', ctrl.get);
router.patch('/', ctrl.update);
router.post('/password', ctrl.changePassword);
router.delete('/sessions', ctrl.revokeSessions);
export default router;
