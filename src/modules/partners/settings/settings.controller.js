import { parseBody } from '../lib/http.js';
import { settingsSchema } from './settings.schemas.js';
import * as svc from './settings.service.js';

export const get = async (_req, res) => res.json({ settings: await svc.getSettings() });
export const update = async (req, res) => res.json({ settings: await svc.update(parseBody(req, settingsSchema)) });
