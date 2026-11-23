import { Router } from 'express';
import { adminCan, requireSession } from '../lib/session.js';
import * as ctrl from './leads.controller.js';

/**
 * /pp/leads — partners: own leads; admins: all (?owner= filters, create needs a partner), by their
 * role's "Leads" (pp_leads) permission.
 */
const router = Router();
router.use(requireSession);
router.get('/', adminCan('pp_leads', 'v'), ctrl.list);
router.post('/', adminCan('pp_leads', 'c'), ctrl.create);
router.get('/:id', adminCan('pp_leads', 'v'), ctrl.get);
router.patch('/:id', adminCan('pp_leads', 'e'), ctrl.update);
router.delete('/:id', adminCan('pp_leads', 'd'), ctrl.remove);
export default router;
