import { Router } from 'express';
import { requireAdmin, requireSession } from '../lib/session.js';
import * as ctrl from './settings.controller.js';

/** /pp/settings — read by every signed-in user, published by admins. */
const router = Router();
router.get('/', requireSession, ctrl.get);
router.put('/', requireSession, requireAdmin, ctrl.update);
export default router;
