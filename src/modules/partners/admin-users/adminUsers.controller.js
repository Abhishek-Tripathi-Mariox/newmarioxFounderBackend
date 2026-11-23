import { parseBody } from '../lib/http.js';
import { publicUser } from '../lib/users.js';
import { adminNewPartnerSchema, adminPatchSchema } from './adminUsers.schemas.js';
import * as svc from './adminUsers.service.js';

export const list = async (req, res) => res.json(await svc.list(req));
export const get = async (req, res) => res.json({ user: publicUser(await svc.find(req.params.id)) });
export const create = async (req, res) => res.status(201).json(await svc.create(parseBody(req, adminNewPartnerSchema)));

export async function update(req, res) {
  const user = await svc.find(req.params.id);
  res.json(await svc.update(req.pp, user, parseBody(req, adminPatchSchema)));
}

export async function remove(req, res) {
  await svc.remove(req.pp, req.params.id);
  res.json({ ok: true });
}
