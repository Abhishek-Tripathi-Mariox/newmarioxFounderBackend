import { tx } from '../../db/mongo.js';
import { CASE_INSENSITIVE } from '../../db/modelKit.js';
import { Role, User } from '../../db/models/index.js';
import { nextId } from '../../core/ids.js';
import { audit } from '../../core/audit.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { MODS, VIEW_EDIT_MODS } from './roles.schemas.js';

/** Built-in locked roles (Super Admin, Partner) can't be edited or deleted. */
const lockedMsg = (role) => `${role.name} is a locked system role`;
const EMPTY_PERM = { v: false, c: false, e: false, d: false, scope: 'all' };
const randomHue = () => Math.floor(Math.random() * 360);
const iso = (d) => (d ? new Date(d).toISOString() : null);

const toDto = (r) => ({
  id: r.id, name: r.name, description: r.description, hue: r.hue, locked: r.locked, perms: r.perms,
  userCount: Number(r.user_count || 0), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

/** Attach `user_count` (users holding the role) to role rows. */
async function withCounts(roles, session = null) {
  const counts = await User.aggregate([
    { $match: { role_id: { $in: roles.map((r) => r.id) } } },
    { $group: { _id: '$role_id', n: { $sum: 1 } } },
  ]).session(session);
  const countOf = new Map(counts.map((c) => [c._id, c.n]));
  return roles.map((r) => ({ ...r, user_count: countOf.get(r.id) || 0 }));
}

export async function list() {
  return (await withCounts(await Role.find().sort({ created_at: 1, _id: 1 }).rows())).map(toDto);
}

async function getRow(id, session = null) {
  const r = await Role.findOne({ id }).session(session).rows();
  if (!r) throw notFound('Role');
  return (await withCounts([r], session))[0];
}
export const get = async (id) => toDto(await getRow(id));

/** "New role", "New role 2", … — role names are unique. */
async function freeName(session, wanted) {
  const taken = new Set((await Role.distinct('name').session(session)).map((n) => n.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; ; i++) if (!taken.has(`${wanted} ${i}`.toLowerCase())) return `${wanted} ${i}`;
}

const normalisePerms = (perms) => Object.fromEntries(MODS.map((m) => [m, { ...EMPTY_PERM, ...(perms?.[m] || {}) }]));

/** New role with a copy of Team Member's permissions (frontend newRole). */
export async function create(req, body) {
  const id = await tx(async (session) => {
    const base = (await Role.findOne({ id: 'r-tm' }).session(session).rows())
      || (await Role.findOne().sort({ created_at: -1 }).session(session).rows());
    const rid = await nextId('role');
    await Role.insertMany([{
      id: rid, name: await freeName(session, body.name || 'New role'), description: body.description || '', hue: randomHue(), locked: false,
      perms: normalisePerms(base?.perms),
    }], { session });
    await audit(req, 'created a new role', 'Role', session);
    return rid;
  });
  return get(id);
}

export async function duplicate(req, roleId) {
  const id = await tx(async (session) => {
    const src = await Role.findOne({ id: roleId }).session(session).rows();
    if (!src) throw notFound('Role');
    const rid = await nextId('role');
    const name = await freeName(session, `${src.name} (copy)`);
    await Role.insertMany([{ id: rid, name, description: src.description, hue: src.hue, locked: false, perms: normalisePerms(src.perms) }], { session });
    await audit(req, `created role ${name}`, 'Role', session);
    return rid;
  });
  return get(id);
}

/**
 * Apply a permission patch with the frontend toggle rules: turning View off clears Create/Edit/Delete,
 * turning any of Create/Edit/Delete on turns View on, and a scope can only be set while View is on.
 * View / Edit-only modules (`pp`) keep Create / Delete off.
 */
export function applyPermPatch(current, patch) {
  const out = normalisePerms(current);
  for (const [mod, p] of Object.entries(patch || {})) {
    const x = { ...out[mod], ...p };
    if (['c', 'e', 'd'].some((a) => p[a] === true)) x.v = true;
    else if (p.v === false) { x.c = false; x.e = false; x.d = false; }
    if (p.scope !== undefined && !x.v) throw unprocessable('Turn on View first');
    // View / Edit-only modules have no Create, Delete or data scope.
    if (VIEW_EDIT_MODS.includes(mod)) Object.assign(x, { c: false, d: false, scope: 'all' });
    out[mod] = x;
  }
  return out;
}

export async function update(req, id, body) {
  await tx(async (session) => {
    const r = await Role.findOne({ id }).session(session).rows();
    if (!r) throw notFound('Role');
    if (r.locked) throw unprocessable(lockedMsg(r));
    // No self-escalation: a non-Super-Admin can't edit the role they hold.
    if (!req.actor.isSuper && req.actor.role.id === id) throw forbidden('You can’t edit your own role.');
    const patch = {};
    if (body.name !== undefined && body.name !== r.name) {
      if (await Role.exists({ name: body.name, _id: { $ne: id } }).collation(CASE_INSENSITIVE).session(session)) throw unprocessable(`A role called “${body.name}” already exists.`);
      patch.name = body.name;
    }
    if (body.description !== undefined) patch.description = body.description;
    if (body.hue !== undefined) patch.hue = body.hue;
    if (body.perms) patch.perms = applyPermPatch(r.perms, body.perms);
    if (!Object.keys(patch).length) return;
    await Role.updateOne({ id }, patch, { session });
    const what = body.perms ? 'permissions of' : '';
    await audit(req, `updated ${what ? `${what} ` : ''}role ${patch.name || r.name}`, 'Role', session);
  });
  return get(id);
}

export async function remove(req, id) {
  await tx(async (session) => {
    const r = await getRow(id, session);
    if (r.locked) throw unprocessable(lockedMsg(r));
    const n = Number(r.user_count);
    if (n) throw unprocessable(`Can't delete role “${r.name}” — ${n} user${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} it`);
    await Role.deleteOne({ id }, { session });
    await audit(req, `deleted role ${r.name}`, 'Role', session);
  });
}
