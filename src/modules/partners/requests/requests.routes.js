import { Router } from 'express';
import { requireSession } from '../lib/session.js';
import * as ctrl from './requests.controller.js';

/** /pp/requests/:kind (scope | booking | tech | ticket) — partners raise and list their own; admins review. */
export const requestsRouter = Router();
requestsRouter.use(requireSession);
requestsRouter.get('/:kind', ctrl.list);
requestsRouter.post('/:kind', ctrl.create);
requestsRouter.patch('/:kind/:id', ctrl.update);
requestsRouter.delete('/:kind/:id', ctrl.remove);

/** /pp/availability?office=&date= — slots already taken at an office. */
export const availabilityRouter = Router();
availabilityRouter.get('/', requireSession, ctrl.availability);
