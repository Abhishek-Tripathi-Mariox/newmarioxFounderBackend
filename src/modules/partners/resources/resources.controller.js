import { parseBody } from '../lib/http.js';
import { resourcePatchSchema, resourceSchema } from './resources.schemas.js';
import * as svc from './resources.service.js';

export const list = async (req, res) => res.json(await svc.list(req.pp, req));
export const create = async (req, res) => res.status(201).json({ item: await svc.create(parseBody(req, resourceSchema)) });

export async function update(req, res) {
  const item = await svc.find(req.params.id);
  res.json({ item: await svc.update(item, parseBody(req, resourcePatchSchema)) });
}

export async function remove(req, res) {
  await svc.remove(req.params.id);
  res.json({ ok: true });
}
