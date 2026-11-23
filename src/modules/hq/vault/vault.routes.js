import { Router } from 'express';
import { ok } from '../../../core/http.js';
import { authenticateHq } from '../core/authenticate.js';
import { validate } from '../core/validate.js';
import { saveVaultBody } from './vault.schemas.js';
import * as vaultService from './vault.service.js';

/** /hq/vault — the founders' sealed vault (one encrypted blob). */
export function createVaultRouter() {
  const router = Router();
  router.use(authenticateHq);

  router.get('/', async (_req, res) => ok(res, await vaultService.getVault()));
  router.put('/', validate({ body: saveVaultBody }), async (req, res) => ok(res, await vaultService.saveVault(req.valid.body, req.hqUser._id)));

  return router;
}
