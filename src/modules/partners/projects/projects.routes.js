import { Router } from 'express';
import { requireAdmin, requireSession } from '../lib/session.js';
import * as ctrl from './projects.controller.js';

/** /pp/projects — read: partners (own) and admins; write: admins. */
const router = Router();
router.use(requireSession);
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireAdmin, ctrl.create);
router.patch('/:id', requireAdmin, ctrl.update);
router.delete('/:id', requireAdmin, ctrl.remove);
export default router;
