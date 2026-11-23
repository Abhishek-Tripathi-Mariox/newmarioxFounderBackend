import { Router } from 'express';
import { ok } from '../../../core/http.js';
import { authenticateHq } from '../core/authenticate.js';
import { validate } from '../core/validate.js';
import { savePrefsBody, saveWorkspaceBody } from './workspace.schemas.js';
import * as workspaceService from './workspace.service.js';

/** /hq/workspace — the shared workspace document (optimistic concurrency) and per-user prefs. */
export function createWorkspaceRouter() {
  const router = Router();
  router.use(authenticateHq);

  router.get('/', async (_req, res) => ok(res, await workspaceService.getWorkspace()));
  router.put('/', validate({ body: saveWorkspaceBody }), async (req, res) => {
    const { data, baseVersion } = req.valid.body;
    ok(res, await workspaceService.saveWorkspace({ data, baseVersion, user: req.hqUser }));
  });
  router.get('/prefs', async (req, res) => ok(res, await workspaceService.getPrefs(req.hqUser._id)));
  router.put('/prefs', validate({ body: savePrefsBody }), async (req, res) =>
    ok(res, await workspaceService.savePrefs(req.hqUser._id, req.valid.body.prefs)));

  return router;
}
