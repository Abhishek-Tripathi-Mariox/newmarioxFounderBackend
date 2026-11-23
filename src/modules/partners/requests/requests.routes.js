import { Router } from 'express';
import { adminCan, requireSession } from '../lib/session.js';
import * as ctrl from './requests.controller.js';

/**
 * /pp/requests/:kind (scope | booking | tech | ticket) — partners raise and list their own; admins
 * review by their role's "Requests" (pp_requests) permission: View = list, Edit = review / reply,
 * Delete = delete. Admins don't raise requests (there is no Create).
 */
export const requestsRouter = Router();
requestsRouter.use(requireSession);
requestsRouter.get('/:kind', adminCan('pp_requests', 'v'), ctrl.list);
requestsRouter.post('/:kind', adminCan('pp_requests', 'c'), ctrl.create);
requestsRouter.patch('/:kind/:id', adminCan('pp_requests', 'e'), ctrl.update);
requestsRouter.delete('/:kind/:id', adminCan('pp_requests', 'd'), ctrl.remove);

/** /pp/availability?office=&date= — slots already taken at an office. */
export const availabilityRouter = Router();
availabilityRouter.get('/', requireSession, adminCan('pp_requests', 'v'), ctrl.availability);
