import { parseBody } from '../lib/http.js';
import * as s from './acquisition.schemas.js';
import * as svc from './acquisition.service.js';

export const list = async (_req, res) => res.json(await svc.list());
export const create = async (req, res) => res.status(201).json({ lead: await svc.create(parseBody(req, s.createSchema)) });
export const update = async (req, res) => res.json(await svc.patch(req.params.id, parseBody(req, s.patchSchema)));
export const settings = async (req, res) => res.json(await svc.saveSettings(parseBody(req, s.settingsSchema)));
export const sample = async (req, res) => res.json(await svc.sample(parseBody(req, s.sampleSchema)));
export const importRows = async (req, res) => res.json(await svc.importRows(parseBody(req, s.importSchema)));

export async function remove(req, res) {
  await svc.remove(req.params.id);
  res.json({ ok: true });
}
