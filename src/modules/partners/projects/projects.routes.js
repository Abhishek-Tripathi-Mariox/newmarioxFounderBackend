import { Router } from 'express';
import { adminCan, adminOnly, requireSession } from '../lib/session.js';
import * as ctrl from './projects.controller.js';

/** /pp/projects — read: partners (own) and admins; write: admins. Admins by "Projects & payouts" (pp_projects). */
const router = Router();
router.use(requireSession);
router.get('/', adminCan('pp_projects', 'v'), ctrl.list);
router.get('/:id', adminCan('pp_projects', 'v'), ctrl.get);
router.post('/', adminOnly('pp_projects', 'c'), ctrl.create);
router.patch('/:id', adminOnly('pp_projects', 'e'), ctrl.update);
router.delete('/:id', adminOnly('pp_projects', 'd'), ctrl.remove);
export default router;
