import crypto from 'node:crypto';
import { Router } from 'express';
import { PpError, parseBody } from '../lib/http.js';
import { createPartner, newPartnerSchema } from '../lib/users.js';

/**
 * /pp/v1/users — the main Mariox website creates partner accounts (mariox-saas src/app/api/v1/users).
 *   POST, header x-api-key: <MAIN_SITE_API_KEY>, body { name, email, phone?, company?, password? … }
 * Without a password the account is invited and the response carries a one-time setPasswordUrl
 * (7 days) for the caller to send; no email is sent from here. Origins in MAIN_SITE_ORIGIN (comma
 * list) get CORS headers.
 */
const allowedOrigins = () => (process.env.MAIN_SITE_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);

function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key');
  res.setHeader('Vary', 'Origin');
  const origin = req.get('origin') || '';
  if (allowedOrigins().includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  next();
}

function checkKey(req) {
  const expected = process.env.MAIN_SITE_API_KEY || '';
  const a = Buffer.from(req.get('x-api-key') || '');
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new PpError(401, 'Invalid API key');
}

const router = Router();
router.use(cors);
router.options('/users', (_req, res) => res.status(204).end());
router.post('/users', async (req, res) => {
  checkKey(req);
  res.status(201).json(await createPartner(parseBody(req, newPartnerSchema), 'main-site'));
});
export default router;
