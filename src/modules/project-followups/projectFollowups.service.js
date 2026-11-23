/**
 * Project follow-ups — meetings, calls, tasks and reminders on a project. Anyone who can see the
 * project (the `projects` module scope) can add, edit and complete them; deleting is limited to the
 * person who created it, its owner, and the project's PM / Super Admin.
 */
import { tx } from '../../db/mongo.js';
import { ilike } from '../../db/modelKit.js';
import { Member, Project, ProjectFollowUp } from '../../db/models/index.js';
import { nextId } from '../../core/ids.js';
import { visibleProjectIds, restrictTo } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import { DAY, parseDay, sod } from '../leads/leads.util.js';
import { FU_DEFAULTS } from '../followups/followups.schemas.js';
import { isPMof } from '../projects/projects.service.js';
import * as prepo from '../projects/projects.repository.js';
import { toProjectFollowUp } from './projectFollowups.mapper.js';

/** Query-string filters → Mongo conditions (the text search also matches the project's name / client). */
async function filterOf(f) {
  const and = [];
  if (f.projectId) and.push({ project_id: f.projectId });
  if (f.owner) and.push({ owner_member_id: f.owner });
  if (f.type) and.push({ type: f.type });
  if (f.priority) and.push({ priority: f.priority });
  if (f.from) and.push({ due_at: { $gte: new Date(parseDay(f.from)) } });
  if (f.to) and.push({ due_at: { $lt: new Date(parseDay(f.to) + DAY) } });
  if (f.q) {
    const projectIds = await Project.distinct('_id', { $or: [{ name: ilike(f.q) }, { client: ilike(f.q) }] });
    and.push({ $or: [{ title: ilike(f.q) }, { project_id: { $in: projectIds } }] });
  }
  return and;
}

/** Conditions of each list tab at time `now`. */
function tabFilters(now) {
  const T = sod(now);
  return {
    today: { done: false, due_at: { $gte: new Date(T), $lt: new Date(T + DAY) } },
    upcoming: { done: false, due_at: { $gte: new Date(T + DAY) } },
    overdue: { done: false, due_at: { $lt: new Date(now) } },
    completed: { done: true },
    all: {},
  };
}

const combine = (and) => (and.length ? { $and: and } : {});

/** Rows → rows joined with their project (name, client) and owner (name), like the old SQL join. */
async function withNames(rows) {
  if (!rows.length) return [];
  const [projects, members] = await Promise.all([
    Project.find({ _id: { $in: [...new Set(rows.map((r) => r.project_id))] } }).select('name client').rows(),
    Member.find({ _id: { $in: [...new Set(rows.map((r) => r.owner_member_id))] } }).select('name').rows(),
  ]);
  const P = new Map(projects.map((p) => [p.id, p]));
  const M = new Map(members.map((m) => [m.id, m.name]));
  return rows.filter((r) => P.has(r.project_id)).map((r) => ({
    ...r, project_name: P.get(r.project_id).name, project_client: P.get(r.project_id).client, owner_name: M.get(r.owner_member_id) ?? null,
  }));
}

export async function list(query, user) {
  const now = Date.now();
  const ids = await visibleProjectIds(user);
  const p = pageParams(query, { defaultSize: 100, maxSize: 500 });
  const base = restrictTo({}, 'project_id', ids);
  const filters = [base, ...(await filterOf(query))];
  const tabs = tabFilters(now);
  const rows = await ProjectFollowUp.find(combine([...filters, tabs[query.tab] || {}]))
    .sort({ due_at: query.tab === 'completed' ? -1 : 1, _id: 1 }).skip(p.offset).limit(p.limit).rows();
  const names = Object.keys(tabs);
  const totals = await Promise.all(names.map((tab) => ProjectFollowUp.countDocuments(combine([...filters, tabs[tab]]))));
  const c = Object.fromEntries(names.map((tab, i) => [tab, totals[i]]));
  return { items: (await withNames(rows)).map(toProjectFollowUp), meta: { ...p.meta(c[query.tab]), counts: c } };
}

async function visibleProject(user, projectId, session = null) {
  const ids = await visibleProjectIds(user);
  const p = await prepo.findProject(projectId, session);
  if (!p || (ids && !ids.includes(p.id))) throw notFound('Project');
  return p;
}

async function readable(id, user, session = null) {
  const [row] = await withNames([await ProjectFollowUp.findOne({ id }).session(session).rows()].filter(Boolean));
  if (!row) throw notFound('Follow-up');
  const ids = await visibleProjectIds(user);
  if (ids && !ids.includes(row.project_id)) throw notFound('Follow-up');
  return row;
}

export const get = async (id, user) => toProjectFollowUp(await readable(id, user));

function dueOf(v) {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function checkOwner(ownerId, session = null) {
  const m = await Member.findOne({ id: ownerId }).select('active').session(session).rows();
  if (!m) throw unprocessable('Pick who this follow-up is assigned to.');
  return m.id;
}

export async function create(b, user) {
  if (!b.title.trim()) throw unprocessable('Add a title.');
  const due = dueOf(b.dueAt);
  if (!due) throw unprocessable('Pick a date and time.');
  const id = await tx(async (session) => {
    const p = await visibleProject(user, b.projectId, session);
    const owner = await checkOwner(b.ownerId || user.memberId || p.pmId, session);
    const [dur, remind] = FU_DEFAULTS[b.type] || [0, 0];
    const fid = await nextId('projectFollowUp');
    await ProjectFollowUp.insertMany([{
      id: fid,
      project_id: p.id,
      type: b.type,
      title: b.title.trim(),
      owner_member_id: owner,
      due_at: due,
      duration_min: b.durationMin ?? dur,
      remind_min: b.remindMin ?? remind,
      priority: b.priority || 'Medium',
      meet_url: b.meetUrl || '',
      attendees: b.attendees || '',
      notes: b.notes || '',
      created_by: user.id,
    }], { session });
    return fid;
  });
  return get(id, user);
}

export async function update(id, b, user) {
  await tx(async (session) => {
    const f = await readable(id, user, session);
    const patch = { notified: false };
    if (b.title !== undefined) {
      if (!b.title.trim()) throw unprocessable('Add a title.');
      patch.title = b.title.trim();
    }
    if (b.dueAt !== undefined) {
      const due = dueOf(b.dueAt);
      if (!due) throw unprocessable('Pick a date and time.');
      patch.due_at = due;
    }
    if (b.projectId !== undefined && b.projectId !== f.project_id) patch.project_id = (await visibleProject(user, b.projectId, session)).id;
    if (b.ownerId !== undefined && b.ownerId !== f.owner_member_id) patch.owner_member_id = await checkOwner(b.ownerId, session);
    if (b.type !== undefined) patch.type = b.type;
    if (b.durationMin !== undefined) patch.duration_min = b.durationMin;
    if (b.remindMin !== undefined) patch.remind_min = b.remindMin;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.meetUrl !== undefined) patch.meet_url = b.meetUrl;
    if (b.attendees !== undefined) patch.attendees = b.attendees;
    if (b.notes !== undefined) patch.notes = b.notes;
    await ProjectFollowUp.updateOne({ id }, { $set: patch }, { session });
  });
  return get(id, user);
}

export async function toggleDone(id, user) {
  await tx(async (session) => {
    const f = await readable(id, user, session);
    await ProjectFollowUp.updateOne({ id }, { done: !f.done }, { session });
  });
  return get(id, user);
}

export async function remove(id, user) {
  await tx(async (session) => {
    const f = await readable(id, user, session);
    const p = await prepo.findProject(f.project_id, session);
    const mine = f.created_by === user.id || (!!user.memberId && f.owner_member_id === user.memberId);
    if (!mine && !isPMof(user, p)) throw forbidden('Only the person who added it, its owner or the project manager can delete this follow-up.');
    await ProjectFollowUp.deleteOne({ id }, { session });
  });
}
