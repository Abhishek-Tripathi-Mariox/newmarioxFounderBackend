import { parseBody } from '../lib/http.js';
import { projectPatchSchema, projectSchema } from './projects.schemas.js';
import * as svc from './projects.service.js';

export const list = async (req, res) => res.json(await svc.list(req.pp, req));
export const get = async (req, res) => res.json({ project: await svc.get(req.pp, req.params.id) });
export const create = async (req, res) => res.status(201).json({ project: await svc.create(parseBody(req, projectSchema)) });
export const update = async (req, res) => res.json({ project: await svc.update(req.params.id, parseBody(req, projectPatchSchema)) });

export async function remove(req, res) {
  await svc.remove(req.params.id);
  res.json({ ok: true });
}
