import { Router } from 'express';
import { adminCan, adminOnly, requireSession } from '../lib/session.js';
import * as ctrl from './resources.controller.js';

/** /pp/resources — sales kit: listed for every partner, managed by admins with "Sales kit" (pp_kit). */
const router = Router();
router.use(requireSession);
router.get('/', adminCan('pp_kit', 'v'), ctrl.list);
router.post('/', adminOnly('pp_kit', 'c'), ctrl.create);
router.patch('/:id', adminOnly('pp_kit', 'e'), ctrl.update);
router.delete('/:id', adminOnly('pp_kit', 'd'), ctrl.remove);
export default router;
