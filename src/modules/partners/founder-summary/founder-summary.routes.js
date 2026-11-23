import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../../../config/index.js';
import { PpError } from '../lib/http.js';
import { partnersSummary } from './founder-summary.service.js';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** `x-founder-key` must equal FOUNDER_API_KEY (SHA-256 digests, timing-safe); 503 while it is unset. */
function founderKey(req, _res, next) {
  const expected = config.founderApiKey;
  if (!expected) throw new PpError(503, 'The founder summary is turned off. Set FOUNDER_API_KEY to turn it on.');
  const got = req.get('x-founder-key') || '';
  if (!got || !crypto.timingSafeEqual(digest(got), digest(expected))) throw new PpError(401, 'Invalid founder key');
  next();
}

/** /pp/founder/summary — read-only partner-network summary, server-to-server only. */
const router = Router();
router.get('/summary', founderKey, async (_req, res) => {
  const data = await partnersSummary();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data });
});
export default router;
