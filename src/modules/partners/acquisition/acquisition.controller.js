import { parseBody } from '../lib/http.js';
import { assertAdminMay } from '../lib/session.js';
import * as s from './acquisition.schemas.js';
import * as svc from './acquisition.service.js';

export const list = async (_req, res) => res.json(await svc.list());
export const create = async (req, res) => res.status(201).json({ lead: await svc.create(parseBody(req, s.createSchema)) });
export const update = async (req, res) => res.json(await svc.patch(req.params.id, parseBody(req, s.patchSchema)));
export const settings = async (req, res) => res.json(await svc.saveSettings(parseBody(req, s.settingsSchema)));
/** Loading sample leads adds leads (Create); clearing them deletes leads (Delete). */
export async function sample(req, res) {
  const body = parseBody(req, s.sampleSchema);
  assertAdminMay(req.pp, 'pp_acq', body.action === 'clear' ? 'd' : 'c');
  res.json(await svc.sample(body));
}
export const importRows = async (req, res) => res.json(await svc.importRows(parseBody(req, s.importSchema)));

export async function remove(req, res) {
  await svc.remove(req.params.id);
  res.json({ ok: true });
}
