import { Router } from 'express';
import { pingMongo } from '../../db/mongo.js';
import { createAuthRouter } from './auth/auth.routes.js';
import { hqErrorTranslator, hqNotFound } from './core/errorHandler.js';
import { createSummaryRouter } from './summary/summary.routes.js';
import { createUsersRouter } from './users/users.routes.js';
import { createVaultRouter } from './vault/vault.routes.js';
import { createWorkspaceRouter } from './workspace/workspace.routes.js';

/**
 * /api/v1/hq — the Founders HQ API (ported from the standalone CofounderMariox backend, same sub-paths,
 * payloads and rules). Signed in with the one Mariox One login (portal session cookie) and open to the
 * holders of an HQ seat (core/authenticate.js, docs/SSO.md). It answers in its own error wording, so it
 * is mounted among the public routes.
 */
export function hqRouter() {
  const router = Router();

  // Liveness + database check. Public, and deliberately not wrapped in `{ data }`.
  router.get('/health', async (_req, res) => {
    try {
      await pingMongo();
      res.json({ status: 'ok', db: 'up', uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });
  router.use('/auth', createAuthRouter());
  router.use('/users', createUsersRouter());
  router.use('/workspace', createWorkspaceRouter());
  router.use('/vault', createVaultRouter());
  router.use('/summary', createSummaryRouter());

  router.use(hqNotFound);
  router.use(hqErrorTranslator);
  return router;
}
