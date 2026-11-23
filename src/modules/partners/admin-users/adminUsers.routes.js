import { Router } from 'express';
import { requireAdmin, requireSession } from '../lib/session.js';
import * as ctrl from './adminUsers.controller.js';

/** /pp/admin/users — partner (and admin) accounts, admins only. */
const router = Router();
router.use(requireSession, requireAdmin);
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.get);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
export default router;
