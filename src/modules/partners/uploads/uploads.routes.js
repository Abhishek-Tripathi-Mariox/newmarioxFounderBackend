import { Router } from 'express';
import { requireSession } from '../lib/session.js';
import * as ctrl from './uploads.controller.js';

/** /pp/uploads — upload (any signed-in user) and open / download a file. */
const router = Router();
router.use(requireSession);
router.post('/', ctrl.receive, ctrl.create);
router.get('/:id', ctrl.download);
export default router;
