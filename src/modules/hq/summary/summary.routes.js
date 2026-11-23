import { Router } from 'express';
import { ok } from '../../../core/http.js';
import { authenticateHq } from '../core/authenticate.js';
import { summaryService } from './summary.service.js';

/** /hq/summary — the two company summaries for the HQ summary page. */
export function createSummaryRouter() {
  const router = Router();
  router.use(authenticateHq);

  router.get('/mariox', async (_req, res) => ok(res, await summaryService().getSummary('mariox')));
  router.get('/partners', async (_req, res) => ok(res, await summaryService().getSummary('partners')));

  return router;
}
