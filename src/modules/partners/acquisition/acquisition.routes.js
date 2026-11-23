import { Router } from 'express';
import { adminOnly, requireSession } from '../lib/session.js';
import * as ctrl from './acquisition.controller.js';

/**
 * /pp/admin/acquisition — partner recruitment board, admins with the "Acquisition" (pp_acq) permission:
 * View = the board; Create = add / import leads, load sample leads; Edit = update / convert / edit a lead,
 * the board's lists and team emails; Delete = delete a lead, clear sample leads (checked in the controller).
 */
const router = Router();
router.use(requireSession, adminOnly('pp_acq', 'v'));
router.get('/', ctrl.list);
router.post('/', adminOnly('pp_acq', 'c'), ctrl.create);
router.put('/settings', adminOnly('pp_acq', 'e'), ctrl.settings);
router.post('/sample', ctrl.sample);
router.post('/import', adminOnly('pp_acq', 'c'), ctrl.importRows);
router.patch('/:id', adminOnly('pp_acq', 'e'), ctrl.update);
router.delete('/:id', adminOnly('pp_acq', 'd'), ctrl.remove);
export default router;
