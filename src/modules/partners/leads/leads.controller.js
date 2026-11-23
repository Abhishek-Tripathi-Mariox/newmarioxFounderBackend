import { parseBody, searchParams } from '../lib/http.js';
import { leadPatchSchema, leadSchema } from './leads.schemas.js';
import * as svc from './leads.service.js';

export const list = async (req, res) => res.json(await svc.list(req.pp, req, searchParams(req).get('owner')));
export const create = async (req, res) => res.status(201).json({ lead: await svc.create(req.pp, parseBody(req, leadSchema)) });
export const get = async (req, res) => res.json({ lead: await svc.get(req.pp, req.params.id) });

export async function update(req, res) {
  const lead = await svc.find(req.pp, req.params.id);
  res.json({ lead: await svc.update(req.pp, lead, parseBody(req, leadPatchSchema)) });
}

export async function remove(req, res) {
  const lead = await svc.find(req.pp, req.params.id);
  await lead.deleteOne();
  res.json({ ok: true });
}
