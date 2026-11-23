import { Router } from 'express';
import { requireAdmin, requireSession } from '../lib/session.js';
import * as ctrl from './resources.controller.js';

/** /pp/resources — sales kit: listed for everyone signed in, managed by admins. */
const router = Router();
router.use(requireSession);
router.get('/', ctrl.list);
router.post('/', requireAdmin, ctrl.create);
router.patch('/:id', requireAdmin, ctrl.update);
router.delete('/:id', requireAdmin, ctrl.remove);
export default router;
