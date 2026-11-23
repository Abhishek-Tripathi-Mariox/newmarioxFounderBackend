import { Router } from 'express';
import { requireSession } from '../lib/session.js';
import * as ctrl from './leads.controller.js';

/** /pp/leads — partners: own leads; admins: all (?owner= filters, create needs a partner). */
const router = Router();
router.use(requireSession);
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.get);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
export default router;
