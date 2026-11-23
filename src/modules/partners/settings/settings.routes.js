import { Router } from 'express';
import { adminOnly, requireSession } from '../lib/session.js';
import * as ctrl from './settings.controller.js';

/** /pp/settings — read by every signed-in user (every page uses the pipeline), published by admins with "Settings" Edit. */
const router = Router();
router.get('/', requireSession, ctrl.get);
router.put('/', requireSession, adminOnly('pp_settings', 'e'), ctrl.update);
export default router;
