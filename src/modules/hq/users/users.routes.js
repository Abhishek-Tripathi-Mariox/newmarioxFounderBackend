import { Router } from 'express';
import { created, noContent, ok } from '../../../core/http.js';
import { sessionMeta, setRefreshCookie } from '../../../core/tokens.js';
import { issueSession } from '../../auth/auth.service.js';
import { authenticateHq, requireSuperAdmin } from '../core/authenticate.js';
import { validate } from '../core/validate.js';
import { createUserBody, setPasswordBody, updateUserBody, userIdParams } from './users.schemas.js';
import * as usersService from './users.service.js';

/** /hq/users — the founders' and co-founders' accounts (Mariox One users who are HQ members), managed from inside the HQ. */
export function createUsersRouter() {
  const router = Router();
  router.use(authenticateHq);

  router.get('/', async (_req, res) => ok(res, await usersService.listUsers()));
  router.post('/', requireSuperAdmin, validate({ body: createUserBody }), async (req, res) => created(res, await usersService.createUser(req, req.valid.body)));
  router.patch('/:id', requireSuperAdmin, validate({ params: userIdParams, body: updateUserBody }), async (req, res) =>
    ok(res, await usersService.updateUser(req, req.valid.params.id, req.valid.body)));
  router.post('/:id/password', requireSuperAdmin, validate({ params: userIdParams, body: setPasswordBody }), async (req, res) => {
    const userId = await usersService.setPassword(req.valid.params.id, req.valid.body.password);
    // Setting your own password ends your other sessions but keeps this one signed in.
    if (userId === req.actor.id) setRefreshCookie(res, (await issueSession(userId, sessionMeta(req))).refreshToken);
    noContent(res);
  });
  router.delete('/:id', requireSuperAdmin, validate({ params: userIdParams }), async (req, res) => {
    await usersService.deleteUser(req, req.valid.params.id);
    noContent(res);
  });

  return router;
}
