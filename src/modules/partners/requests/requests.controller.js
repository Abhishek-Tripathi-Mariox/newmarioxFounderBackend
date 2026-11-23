import { searchParams } from '../lib/http.js';
import * as svc from './requests.service.js';

export const list = async (req, res) => res.json(await svc.list(req.pp, req.params.kind, req));
export const create = async (req, res) => res.status(201).json({ item: await svc.create(req.pp, req.params.kind, req) });
export const update = async (req, res) => res.json({ item: await svc.update(req.pp, req.params.kind, req.params.id, req) });

export async function remove(req, res) {
  await svc.remove(req.pp, req.params.kind, req.params.id);
  res.json({ ok: true });
}

export async function availability(req, res) {
  const p = searchParams(req);
  res.json({ taken: await svc.availability(p.get('office'), p.get('date')) });
}
