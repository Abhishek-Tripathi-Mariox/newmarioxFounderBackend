/**
 * Team tasks — independent of projects. Rights come from the role's `tt` (Team tasks) permission:
 * - scope All: sees every task and can give tasks to anyone.
 * - scope Team: sees tasks assigned to / created by them and tasks of people below them in
 *   "Reports to" (direct or indirect); gives tasks to themself or those people.
 * - scope Own: only tasks assigned to / created by them; gives tasks to themself only.
 * Create = give tasks. A task's managers (creator, someone above the assignee, scope All) edit it
 * with Edit and delete it with Delete. The assignee can always change status, write a progress
 * note and add their own files.
 */
import { tx } from '../../db/mongo.js';
import { TEXT_ORDER } from '../../db/modelKit.js';
import { Lead, Project, Role, TeamTask, TeamTaskEvent, User } from '../../db/models/index.js';
import { PARTNER_ROLE } from '../../db/models/roles.js';
import { nextId } from '../../core/ids.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import { reporteesOf } from '../../middleware/authenticate.js';
import { sendMail, mailEnabled } from '../../core/mailer.js';
import { layout, esc } from '../../core/emailLayout.js';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { documentsService } from '../documents/documents.service.js';

const FULL = { v: true, c: true, e: true, d: true, scope: 'all' };
/** The user's Team tasks permission ({v,c,e,d,scope}); Super Admin = everything. */
export const ttPerm = (user) => (user.isSuper ? FULL : ((user.role.perms || {}).tt || { v: false, c: false, e: false, d: false, scope: 'own' }));
const isBoss = (user) => ttPerm(user).scope === 'all';

/** Ids of the people `user` manages (below them in "Reports to"); none with scope Own. */
const teamIds = async (user) => (ttPerm(user).scope === 'own' ? [] : (user.reportees || (await reporteesOf(user.id))).map((r) => r.id));

/** id → row for the given ids of a model (only `fields`). */
async function byIds(Model, ids, fields, session) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  return new Map((await Model.find({ id: { $in: wanted } }).select(fields).session(session).rows()).map((r) => [r.id, r]));
}

/**
 * Task rows with the names shown next to them (assignee_name, creator_name, project_name,
 * lead_company, lead_contact). Tasks whose assignee no longer exists are dropped (old inner join).
 */
async function withNames(rows, session = null) {
  const [users, projects, leads] = await Promise.all([
    byIds(User, rows.flatMap((r) => [r.assignee_id, r.created_by]), 'name', session),
    byIds(Project, rows.map((r) => r.project_id), 'name', session),
    byIds(Lead, rows.map((r) => r.lead_id), 'company contact', session),
  ]);
  return rows.filter((r) => users.has(r.assignee_id)).map((r) => ({
    ...r,
    assignee_name: users.get(r.assignee_id).name,
    creator_name: users.get(r.created_by)?.name ?? null,
    project_name: projects.get(r.project_id)?.name ?? null,
    lead_company: leads.get(r.lead_id)?.company ?? null,
    lead_contact: leads.get(r.lead_id)?.contact ?? null,
  }));
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const day = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Record one timeline event (inside the caller's transaction when `session` is given). */
export async function logEvent(taskId, user, kind, { from = null, to = null, text = null, meta = {} } = {}, session = null) {
  await TeamTaskEvent.insertMany([{
    task_id: taskId, user_id: user ? user.id : null, kind,
    from_val: from == null ? null : String(from).slice(0, 300),
    to_val: to == null ? null : String(to).slice(0, 300),
    text: text ? String(text).slice(0, 5000) : null,
    meta: meta || {},
  }], { session });
}

/** Tasks saved before companies existed belong to Mariox. */
export const DEFAULT_COMPANY = 'mariox';
const companyOf = (r) => r.company_id || DEFAULT_COMPANY;
/** Mongo filter for one company (old rows without company_id count as Mariox). */
const companyFilter = (company) => (company === DEFAULT_COMPANY
  ? { $or: [{ company_id: DEFAULT_COMPANY }, { company_id: null }] }
  : { company_id: company });

const FIELD_LABEL = { company: 'Company', title: 'Title', notes: 'Details', priority: 'Priority', dueDate: 'Due date', estimateHours: 'Estimate', project: 'Project', lead: 'Lead' };

/** Estimated hours: '' / null / 0 → not set. */
const estValue = (v) => (v === '' || v == null || !(+v > 0) ? null : Math.round(+v * 100) / 100);

/** Adds uploaderName to each attachment (who added the file). */
async function withUploaders(docs) {
  const all = [].concat(...Object.values(docs));
  const ids = [...new Set(all.map((d) => d.uploadedBy).filter(Boolean))];
  if (!ids.length) return docs;
  const names = Object.fromEntries((await User.find({ id: { $in: ids } }).select('name').rows()).map((u) => [u.id, u.name]));
  all.forEach((d) => { d.uploaderName = names[d.uploadedBy] || null; });
  return docs;
}

function toDto(r, user, team, attachments) {
  const manager = isBoss(user) || r.created_by === user.id || team.includes(r.assignee_id);
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    priority: r.priority,
    status: r.status,
    dueDate: day(r.due_date),
    estimateHours: r.estimate_hours == null ? null : Number(r.estimate_hours),
    projectId: r.project_id || null,
    projectName: r.project_name || null,
    leadId: r.lead_id || null,
    leadName: r.lead_id ? (r.lead_company || r.lead_contact || r.lead_id) : null,
    companyId: companyOf(r),
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name,
    createdBy: r.created_by,
    creatorName: r.creator_name || null,
    updateNote: r.update_note,
    doneAt: iso(r.done_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    canEdit: manager && !!ttPerm(user).e,
    canDelete: manager && !!ttPerm(user).d,
    canUpdateStatus: (manager && !!ttPerm(user).e) || r.assignee_id === user.id,
    attachments: attachments || [],
  };
}

/** Mongo filter for the tasks the user can see. */
function scoped(user, team) {
  if (isBoss(user)) return {};
  return { $or: [{ assignee_id: user.id }, { created_by: user.id }, { assignee_id: { $in: team } }] };
}

export async function list(query, user) {
  const team = await teamIds(user);
  const p = pageParams(query, { defaultSize: 500, maxSize: 1000 });
  const filter = query.company ? { $and: [scoped(user, team), companyFilter(query.company)] } : scoped(user, team);
  // Newest first; tasks created in the same millisecond keep their creation order (TT12 before TT11).
  const [page, n] = await Promise.all([
    TeamTask.aggregate([
      { $match: filter },
      { $addFields: { seq: { $toInt: { $substrCP: ['$_id', 2, { $subtract: [{ $strLenCP: '$_id' }, 2] }] } } } },
      { $sort: { created_at: -1, seq: -1 } },
      { $skip: p.offset },
      { $limit: p.limit },
      { $project: { seq: 0 } },
    ]),
    TeamTask.countDocuments(filter),
  ]);
  const rows = await withNames(page.map(TeamTask.toRow));
  const docs = await withUploaders(await documentsService.listForMany('team_task', rows.map((r) => r.id)));
  const counts = await eventCounts(rows.map((r) => r.id));
  return { items: rows.map((r) => ({ ...toDto(r, user, team, docs[r.id]), ...counts[r.id] })), meta: p.meta(Number(n)) };
}

/** {taskId: {comments, events}} for the list badges. */
async function eventCounts(ids) {
  const out = Object.fromEntries(ids.map((id) => [id, { comments: 0, events: 0 }]));
  if (!ids.length) return out;
  const rows = await TeamTaskEvent.aggregate([
    { $match: { task_id: { $in: ids } } },
    { $group: { _id: '$task_id', comments: { $sum: { $cond: [{ $eq: ['$kind', 'comment'] }, 1, 0] } }, events: { $sum: 1 } } },
  ]);
  rows.forEach((r) => { out[r._id] = { comments: r.comments, events: r.events }; });
  return out;
}

async function readable(id, user, session = null) {
  const team = await teamIds(user);
  const task = await TeamTask.findOne({ $and: [{ id }, scoped(user, team)] }).session(session).rows();
  const [row] = task ? await withNames([task], session) : [];
  if (!row) throw notFound('Task');
  return { row, team };
}

export async function get(id, user) {
  const { row, team } = await readable(id, user);
  const docs = await withUploaders({ [id]: await documentsService.listFor('team_task', id) });
  return { ...toDto(row, user, team, docs[id]), ...(await eventCounts([id]))[id] };
}

/** For document downloads / removal: null when the user can't see the task, else its rights. */
export async function taskAccess(id, user) {
  try {
    const { row, team } = await readable(id, user);
    const d = toDto(row, user, team);
    return { canEdit: d.canEdit, canUpdateStatus: d.canUpdateStatus };
  } catch {
    return null;
  }
}

/** Upload files to a task (multipart "files"): the assignee, whoever gave it, or a manager above the assignee. */
export async function addAttachments(id, files, user, title = '') {
  try {
    const { row, team } = await readable(id, user);
    if (!toDto(row, user, team).canUpdateStatus) throw forbidden('Only the assignee, the person who gave this task or their manager can add files to it.');
    if (!files || !files.length) throw unprocessable('Pick at least one file.');
    if (String(title || '').length > 200) throw unprocessable('Keep the file title under 200 characters.');
    const added = await documentsService.attach('team_task', id, files, user, null, { title });
    await logEvent(id, user, 'attach', { text: String(title || '').trim() || null, meta: { files: added.map((d) => ({ id: d.id, name: d.name })) } });
  } catch (e) {
    await documentsService.discard(files);
    throw e;
  }
  return get(id, user);
}

/** External accounts (clients, partners) never receive team tasks. */
const NOT_STAFF = ['r-client', PARTNER_ROLE];

/** People this user may give a task to: themself + their reportees (everyone for Super Admin / Admin). */
export async function assignees(user) {
  if (!ttPerm(user).c) return [];
  if (isBoss(user)) {
    const rows = await User.find({ status: 'Active', role_id: { $nin: NOT_STAFF } })
      .sort({ name: 1, _id: 1 }).collation(TEXT_ORDER).select('name role_id').rows();
    const roles = await byIds(Role, rows.map((r) => r.role_id), 'name', null);
    return rows.filter((r) => roles.has(r.role_id))
      .map((r) => ({ id: r.id, name: r.name, role: roles.get(r.role_id).name, self: r.id === user.id }));
  }
  const team = ttPerm(user).scope === 'own' ? [] : user.reportees || (await reporteesOf(user.id));
  return [{ id: user.id, name: user.name, role: user.role.name, self: true }].concat(team.map((r) => ({ id: r.id, name: r.name, role: r.role, self: false })));
}

async function checkAssignee(user, assigneeId, session = null) {
  const u = await User.findOne({ id: assigneeId }).select('name email status role_id').session(session).rows();
  if (!u || u.status !== 'Active' || NOT_STAFF.includes(u.role_id)) throw unprocessable('Pick who this task is for.');
  if (assigneeId === user.id || isBoss(user)) return u;
  if (!(await teamIds(user)).includes(assigneeId)) throw forbidden(ttPerm(user).scope === 'own' ? 'Your role can only add tasks for yourself.' : 'You can only give tasks to yourself or people who report to you.');
  return u;
}

const dueValue = (v) => (v ? v : null);

/** Optional lead link: must be a lead the person giving the task can see (Leads view + scope). */
async function leadValue(user, id, session = null) {
  if (!id) return null;
  const lv = user.isSuper || !!(((user.role.perms || {}).leads || {}).v);
  const l = await Lead.findOne({ id }).select('owner_id').session(session).rows();
  if (!lv || !l) throw unprocessable('Pick a lead you can see.');
  const { people } = await peopleScope(user, 'leads');
  if (people && !people.includes(l.owner_id)) throw unprocessable('Pick a lead you can see.');
  return id;
}

/** Optional project link: must be a project the person giving the task can see. */
async function projectValue(user, id, session = null) {
  if (!id) return null;
  const ids = await visibleProjectIds(user);
  const p = await Project.exists({ id }).session(session);
  if (!p || (ids && !ids.includes(id))) throw unprocessable('Pick a project you can see.');
  return id;
}

function notify(assignee, task, by) {
  if (!mailEnabled() || !assignee.email || assignee.id === by.id) return;
  const link = `${config.appUrl}/team-tasks`;
  const body = `<p><b>${esc(task.title)}</b>${task.projectName ? ` · ${esc(task.projectName)}` : ''}${task.leadName ? ` · Lead: ${esc(task.leadName)}` : ''}</p>${task.notes ? `<p style="white-space:pre-wrap">${esc(task.notes)}</p>` : ''}`
    + `<p>Priority: ${esc(task.priority)}${task.dueDate ? ` · Due: ${esc(task.dueDate)}` : ''}${task.estimateHours ? ` · Estimate: ${task.estimateHours}h` : ''}</p>`;
  sendMail({
    to: assignee.email,
    subject: `New task from ${by.name}: ${task.title}`,
    text: `${by.name} gave you a task: ${task.title}\n${task.notes || ''}\n${link}`,
    html: layout({ heading: 'You have a new task', intro: `${esc(by.name)} gave you a task.`, body, button: 'Open my tasks', link, footer: 'Mariox portal · Team tasks' }),
  }).catch((e) => logger.warn({ err: e }, 'team task email failed'));
}

export async function create(b, user) {
  const { id, assignee } = await tx(async (session) => {
    if (!ttPerm(user).c) throw forbidden('Your role can’t give tasks.');
    const a = await checkAssignee(user, b.assigneeId, session);
    const projectId = await projectValue(user, b.projectId, session);
    const leadId = await leadValue(user, b.leadId, session);
    const tid = await nextId('teamTask');
    const status = b.status || 'To do';
    await TeamTask.insertMany([{
      id: tid,
      title: b.title.trim(),
      notes: b.notes || '',
      priority: b.priority || 'Medium',
      status,
      due_date: dueValue(b.dueDate),
      estimate_hours: estValue(b.estimateHours),
      project_id: projectId,
      lead_id: leadId,
      company_id: b.companyId || DEFAULT_COMPANY,
      assignee_id: a.id,
      created_by: user.id,
      done_at: status === 'Done' ? new Date() : null,
    }], { session });
    await logEvent(tid, user, 'created', { to: a.name, text: b.notes || null, meta: { status, priority: b.priority || 'Medium', dueDate: b.dueDate || null, companyId: b.companyId || DEFAULT_COMPANY } }, session);
    return { id: tid, assignee: a };
  });
  const dto = await get(id, user);
  notify(assignee, dto, user);
  return dto;
}

export async function update(id, b, user) {
  let reassigned = null;
  await tx(async (session) => {
    const { row, team } = await readable(id, user, session);
    const dto = toDto(row, user, team);
    const managerFields = ['title', 'notes', 'priority', 'dueDate', 'estimateHours', 'assigneeId', 'projectId', 'leadId', 'companyId'].filter((k) => b[k] !== undefined);
    if (managerFields.length && !dto.canEdit) throw forbidden('Only the person who gave this task (or their manager) can change it — you can update its status and progress note.');
    if ((b.status !== undefined || b.updateNote !== undefined) && !dto.canUpdateStatus) throw forbidden('You can’t update this task.');
    const patch = {};
    if (b.title !== undefined) patch.title = b.title.trim();
    if (b.notes !== undefined) patch.notes = b.notes;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.dueDate !== undefined) patch.due_date = dueValue(b.dueDate);
    if (b.estimateHours !== undefined) patch.estimate_hours = estValue(b.estimateHours);
    if (b.updateNote !== undefined) patch.update_note = b.updateNote;
    if (b.companyId !== undefined && b.companyId !== companyOf(row)) patch.company_id = b.companyId;
    if (b.projectId !== undefined && (b.projectId || null) !== row.project_id) patch.project_id = await projectValue(user, b.projectId, session);
    if (b.leadId !== undefined && (b.leadId || null) !== row.lead_id) patch.lead_id = await leadValue(user, b.leadId, session);
    if (b.assigneeId !== undefined && b.assigneeId !== row.assignee_id) {
      reassigned = await checkAssignee(user, b.assigneeId, session);
      patch.assignee_id = reassigned.id;
    }
    const comment = (b.comment || '').trim();
    if (b.status !== undefined && b.status !== row.status) {
      // Reopening finished work needs a reason, so the timeline shows why.
      if (b.status === 'Reopened' && row.status !== 'Done') throw unprocessable('Only a Done task can be reopened.');
      if (row.status === 'Done' && !comment) throw unprocessable('Write why you are reopening this task.');
      patch.status = b.status;
      patch.done_at = b.status === 'Done' ? new Date() : null;
    }
    if (Object.keys(patch).length) await TeamTask.updateOne({ id }, patch, { session });

    // Timeline: what changed, by whom.
    if (patch.status) await logEvent(id, user, 'status', { from: row.status, to: patch.status, text: comment || null, meta: { reopened: row.status === 'Done' } }, session);
    else if (comment) await logEvent(id, user, 'comment', { text: comment }, session);
    if (b.updateNote !== undefined && (b.updateNote || '').trim() !== (row.update_note || '').trim() && (b.updateNote || '').trim()) {
      await logEvent(id, user, 'note', { text: b.updateNote.trim() }, session);
    }
    if (reassigned) {
      const old = await User.findOne({ id: row.assignee_id }).select('name').session(session).rows();
      await logEvent(id, user, 'assign', { from: old ? old.name : row.assignee_id, to: reassigned.name }, session);
    }
    const changes = [];
    const add = (field, from, to) => { if (String(from ?? '') !== String(to ?? '')) changes.push({ field, label: FIELD_LABEL[field], from: from ?? '', to: to ?? '' }); };
    if (patch.company_id !== undefined) add('company', companyOf(row), patch.company_id);
    if (patch.title !== undefined) add('title', row.title, patch.title);
    if (patch.notes !== undefined && patch.notes !== row.notes) changes.push({ field: 'notes', label: FIELD_LABEL.notes, from: '', to: '' });
    if (patch.priority !== undefined) add('priority', row.priority, patch.priority);
    if (patch.due_date !== undefined) add('dueDate', day(row.due_date), patch.due_date);
    if (patch.estimate_hours !== undefined) add('estimateHours', row.estimate_hours == null ? '' : `${Number(row.estimate_hours)}h`, patch.estimate_hours == null ? '' : `${patch.estimate_hours}h`);
    if (patch.project_id !== undefined) {
      const [o, n] = await Promise.all([row.project_id, patch.project_id].map((x) => (x ? Project.findOne({ id: x }).select('name').session(session).rows() : null)));
      add('project', o ? o.name : '', n ? n.name : '');
    }
    if (patch.lead_id !== undefined) add('lead', row.lead_id || '', patch.lead_id || '');
    if (changes.length) await logEvent(id, user, 'edit', { meta: { changes } }, session);
  });
  const dto = await get(id, user).catch(() => null);
  if (reassigned && dto) notify(reassigned, dto, user);
  // Reassigned away from someone outside your view: return a minimal stub.
  return dto || { id, removed: true };
}

export async function remove(id, user) {
  const removeFiles = await tx(async (session) => {
    const { row, team } = await readable(id, user, session);
    if (!toDto(row, user, team).canDelete) throw forbidden('Only the person who gave this task (or their manager) can delete it.');
    const cleanup = await documentsService.removeForEntity('team_task', id, session);
    await TeamTaskEvent.deleteMany({ task_id: id }, { session }); // ON DELETE CASCADE
    await TeamTask.deleteOne({ id }, { session });
    return cleanup;
  });
  await removeFiles();
}

/** Timeline of one task, oldest first: [{id, kind, by, byName, from, to, text, meta, at}]. */
export async function activity(id, user) {
  await readable(id, user);
  const rows = await TeamTaskEvent.find({ task_id: id }).sort({ created_at: 1, _id: 1 }).rows();
  const users = await byIds(User, rows.map((r) => r.user_id), 'name', null);
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind, by: r.user_id, byName: users.get(r.user_id)?.name || 'Someone', from: r.from_val, to: r.to_val, text: r.text, meta: r.meta || {}, at: iso(r.created_at),
  }));
}

/** Anyone who can see the task can comment on it. */
export async function comment(id, text, user) {
  await readable(id, user);
  await logEvent(id, user, 'comment', { text: text.trim() });
  return activity(id, user);
}
