import { Router } from 'express';
import { PpError } from '../lib/http.js';
import { adminMay, requireSession } from '../lib/session.js';
import * as ctrl from './uploads.controller.js';

/** /pp/uploads — upload (any signed-in user) and open / download a file. */
const router = Router();
router.use(requireSession);
// Admins upload sales-kit files: their role needs "Sales kit" Create or Edit.
function mayUpload(req, _res, next) {
  if (req.pp.role === 'admin' && !adminMay(req.pp, 'pp_kit', 'c') && !adminMay(req.pp, 'pp_kit', 'e')) {
    throw new PpError(403, 'Your role can’t add files to the sales kit in Mariox Partners');
  }
  next();
}

router.post('/', mayUpload, ctrl.receive, ctrl.create);
router.get('/:id', ctrl.download);
export default router;
