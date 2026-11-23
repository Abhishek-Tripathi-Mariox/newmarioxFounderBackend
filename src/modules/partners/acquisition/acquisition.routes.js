import { Router } from 'express';
import { requireAdmin, requireSession } from '../lib/session.js';
import * as ctrl from './acquisition.controller.js';

/** /pp/admin/acquisition — partner recruitment board, admins only. */
const router = Router();
router.use(requireSession, requireAdmin);
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.put('/settings', ctrl.settings);
router.post('/sample', ctrl.sample);
router.post('/import', ctrl.importRows);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
export default router;
