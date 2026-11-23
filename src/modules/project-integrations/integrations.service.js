/**
 * Project third parties + credentials.
 *  - See the list (names, labels, no values): anyone who can see the project (never clients).
 *  - Reveal a value: Super Admin, the project's PM, or a member of the project team — every reveal is
 *    written to the activity log.
 *  - Add / edit / delete: Super Admin or the project's PM.
 * Values are encrypted with CREDENTIALS_KEY (core/secretBox) and never returned in lists.
 */
import { tx } from '../../db/mongo.js';
import { ProjectCredential, ProjectIntegration, User } from '../../db/models/index.js';
import { visibleProjectIds } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { open, seal, secretsEnabled } from '../../core/secretBox.js';
import { isPMof } from '../projects/projects.service.js';
import * as prepo from '../projects/projects.repository.js';

const iso = (t) => (t ? new Date(t).toISOString() : null);

async function project(user, projectId, session = null) {
  if (user.role?.id === 'r-client') throw forbidden();
  const ids = await visibleProjectIds(user);
  const p = await prepo.findProject(projectId, session);
  if (!p || (ids && !ids.includes(p.id))) throw notFound('Project');
  return p;
}

const canReveal = (user, p) => isPMof(user, p) || (!!user.memberId && (p.pmId === user.memberId || p.team.some((t) => t.memberId === user.memberId)));
const needPM = (user, p) => { if (!isPMof(user, p)) throw forbidden("Only the project's PM can change third parties and credentials."); };

async function integration(user, id, session = null) {
  const row = await ProjectIntegration.findOne({ id }).session(session).rows();
  if (!row) throw notFound('Third party');
  const p = await project(user, row.project_id, session);
  return { row, p };
}

function toDto(r, creds, names) {
  return {
    id: Number(r.id), projectId: r.project_id, name: r.name, category: r.category, status: r.status, url: r.url, notes: r.notes,
    credentials: creds.filter((c) => String(c.integration_id) === String(r.id)).map((c) => ({
      id: Number(c.id), label: c.label, env: c.env, updatedAt: iso(c.updated_at), updatedBy: names[c.updated_by] || null,
    })),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** A project's integrations (or just `only`) with their credentials (labels, never values). */
async function load(projectId, only = null) {
  const filter = only == null ? { project_id: projectId } : { project_id: projectId, _id: only };
  const rows = await ProjectIntegration.find(filter).sort({ _id: 1 }).rows();
  const creds = rows.length
    ? await ProjectCredential.find({ integration_id: { $in: rows.map((r) => r.id) } }).sort({ position: 1, _id: 1 }).rows()
    : [];
  const uids = [...new Set(creds.map((c) => c.updated_by).filter(Boolean))];
  const names = uids.length ? Object.fromEntries((await User.find({ _id: { $in: uids } }).select('name').rows()).map((u) => [u.id, u.name])) : {};
  return rows.map((r) => toDto(r, creds, names));
}

export async function list(user, projectId) {
  const p = await project(user, projectId);
  return {
    items: await load(p.id),
    canManage: isPMof(user, p),
    canReveal: canReveal(user, p),
    credentialsEnabled: secretsEnabled(),
  };
}

/**
 * Turn a credential list into the writes to apply to an integration — validating everything first, so
 * nothing is written when one entry is wrong. New credentials need a value; existing ones keep theirs
 * unless a new one is given. `replace` drops the credentials missing from the list.
 */
async function planCreds(integrationId, list, user, { replace }, session) {
  const existing = integrationId == null ? [] : await ProjectCredential.find({ integration_id: integrationId }).session(session).rows();
  const keep = new Set();
  const updates = [];
  const inserts = [];
  for (const [i, c] of list.entries()) {
    const value = c.value ?? '';
    if (c.id) {
      const cur = existing.find((x) => Number(x.id) === c.id);
      if (!cur) throw unprocessable('A credential in the list no longer exists — reload and try again.');
      keep.add(Number(cur.id));
      const patch = { label: c.label, env: c.env, position: i };
      if (value !== '') Object.assign(patch, { value_enc: seal(value), updated_by: user.id });
      updates.push({ updateOne: { filter: { _id: cur.id }, update: { $set: patch } } });
    } else {
      if (value === '') throw unprocessable(`Enter a value for "${c.label}".`);
      inserts.push({ label: c.label, env: c.env, value_enc: seal(value), updated_by: user.id, position: i });
    }
  }
  const drop = replace ? existing.filter((x) => !keep.has(Number(x.id))).map((x) => x.id) : [];
  return { updates, inserts, drop };
}

async function writeCreds(integrationId, { updates, inserts, drop }, session) {
  if (updates.length) await ProjectCredential.bulkWrite(updates, { session });
  if (inserts.length) await ProjectCredential.insertMany(inserts.map((c) => ({ integration_id: integrationId, ...c })), { session });
  if (drop.length) await ProjectCredential.deleteMany({ _id: { $in: drop } }, { session });
}

export async function create(user, b) {
  const p = await project(user, b.projectId);
  needPM(user, p);
  const id = await tx(async (session) => {
    const plan = await planCreds(null, b.credentials || [], user, { replace: false }, session);
    const [row] = await ProjectIntegration.insertRows([{
      project_id: p.id, name: b.name, category: b.category, status: b.status, url: b.url, notes: b.notes.trim(), created_by: user.id,
    }], session);
    await writeCreds(row.id, plan, session);
    return row.id;
  });
  return (await load(p.id, id))[0];
}

export async function update(user, id, b) {
  const { row, p } = await integration(user, id);
  needPM(user, p);
  await tx(async (session) => {
    const plan = b.credentials ? await planCreds(id, b.credentials, user, { replace: true }, session) : null;
    const patch = {};
    for (const k of ['name', 'category', 'status', 'url']) if (b[k] !== undefined) patch[k] = b[k];
    if (b.notes !== undefined) patch.notes = b.notes.trim();
    if (Object.keys(patch).length) await ProjectIntegration.updateOne({ id }, { $set: patch }, { session });
    if (plan) await writeCreds(id, plan, session);
  });
  return (await load(row.project_id, id))[0];
}

/** Delete a third party and (ON DELETE CASCADE) its credentials. */
export async function remove(user, id) {
  const { p } = await integration(user, id);
  needPM(user, p);
  await tx(async (session) => {
    await ProjectCredential.deleteMany({ integration_id: id }, { session });
    await ProjectIntegration.deleteOne({ id }, { session });
  });
}

/** Decrypt one credential for someone allowed to see it, and log who looked. */
export async function reveal(req, id, credId) {
  const user = req.user;
  const { row, p } = await integration(user, id);
  if (!canReveal(user, p)) throw forbidden('Only the PM and the project team can see credentials.');
  const c = await ProjectCredential.findOne({ id: credId, integration_id: id }).rows();
  if (!c) throw notFound('Credential');
  const value = open(c.value_enc);
  await audit(req, `Viewed ${row.name} · ${c.label} (${c.env}) on ${p.id} ${p.name}`, 'Credentials');
  return { id: Number(c.id), value };
}
