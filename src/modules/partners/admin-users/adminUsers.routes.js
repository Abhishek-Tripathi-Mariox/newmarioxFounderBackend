import { Router } from 'express';
import { adminOnly, requireAdmin, requireSession } from '../lib/session.js';
import * as ctrl from './adminUsers.controller.js';

/**
 * /pp/admin/users — partner (and admin) accounts, admins with the "Partners" (pp_partners) permission:
 * View = list / open, Create = invite / add, Edit = profile, commission, KYC, status, password, invite
 * link, Delete = delete. The list is also open (names only, partners only) to admins who can view partner
 * leads or projects: their pages pick a partner from it.
 */
const router = Router();
router.use(requireSession, requireAdmin);
router.get('/', ctrl.list);
router.post('/', adminOnly('pp_partners', 'c'), ctrl.create);
router.get('/:id', adminOnly('pp_partners', 'v'), ctrl.get);
router.patch('/:id', adminOnly('pp_partners', 'e'), ctrl.update);
router.delete('/:id', adminOnly('pp_partners', 'd'), ctrl.remove);
export default router;
