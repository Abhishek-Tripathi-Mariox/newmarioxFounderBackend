/**
 * Change requests (port of store/slices/delivery.js saveCr + crAct). Visible via the project scope;
 * every write is PM-only (isPMof). The approval workflow (`applyDecision`) is shared with the
 * public client portal (clientApprove / clientReject).
 */
import { tx } from '../../db/mongo.js';
import { ChangeRequest, CrHistory, Member, Milestone, Project, ProjectMember, Task, TimeLog } from '../../db/models/index.js';
import { ilike } from '../../db/modelKit.js';
import { nextId } from '../../core/ids.js';
import { visibleProjectIds, restrictTo } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import * as prepo from '../projects/projects.repository.js';
import { toDocument } from '../projects/projects.mapper.js';
import { isPMof, canSee } from '../projects/projects.service.js';
import { attachDocuments, removeDocuments } from '../projects/documents.js';
import { crMoney, crRate, money } from '../projects/projects.domain.js';
import { dn, ds, todayN } from '../projects/dates.js';
import { toCr, toTasks } from './changeRequests.mapper.js';
import { printCrHtml } from './print.js';
import { emailCrToClient, clientMailNote } from '../projects/clientEmails.js';
import { documentsService } from '../documents/documents.service.js';

const LOCKED_MSG = 'This change request is approved — only its documents can change.';

/* ───────────── Loading & access ───────────── */

async function loadCr(id, session = null) {
  const r = await ChangeRequest.findOne({ id }).session(session).rows();
  return r ? toCr(r) : null;
}

/** Read: 404 when missing or outside scope. */
async function visibleCr(user, id) {
  const c = await loadCr(id);
  if (!c || !(await canSee(user, c.projectId))) throw notFound('Change request');
  return c;
}

/** Write: 404 when missing, 403 unless the project's PM (or Super Admin). */
async function pmCr(user, id, session = null) {
  const c = await loadCr(id, session);
  if (!c) throw notFound('Change request');
  await prepo.lockProject(c.projectId, session); // serialise approvals / edits per project
  const p = await prepo.findProject(c.projectId, session);
  if (!isPMof(user, p)) throw forbidden("Only the project's PM can change this");
  return { c, p };
}

/** Money picture for a set of CRs (needs CR-milestone logs, project milestones, members). */
async function moneyFor(crs, session = null) {
  if (!crs.length) return [];
  const msIds = crs.map((c) => c.milestoneId).filter(Boolean);
  const [members, milestones, logs] = await Promise.all([
    prepo.findMembers(session),
    prepo.findMilestones(Array.from(new Set(crs.map((c) => c.projectId))), session),
    msIds.length ? TimeLog.find({ milestone_id: { $in: msIds } }).select('member_id milestone_id hours').session(session).rows() : [],
  ]);
  const L = logs.map((l) => ({ memberId: l.member_id, milestoneId: l.milestone_id, hours: Number(l.hours) }));
  return crs.map((c) => crMoney(c, { logs: L, milestones, members }));
}

/* ───────────── Reads ───────────── */

export async function list(user, query) {
  const ids = await visibleProjectIds(user);
  const and = [];
  if (query.status) and.push({ status: query.status });
  if (query.project) and.push({ project_id: query.project });
  if (query.q) and.push({ $or: [{ title: ilike(query.q) }, { _id: ilike(query.q) }] });
  const filter = restrictTo(and.length ? { $and: and } : {}, 'project_id', ids);
  const pg = pageParams(query);
  const [n, found] = await Promise.all([
    ChangeRequest.countDocuments(filter),
    // raised_at is NOT NULL: no NULL ordering to emulate.
    ChangeRequest.find(filter).sort({ raised_at: -1, _id: -1 }).skip(pg.offset).limit(pg.limit).rows(),
  ]);
  const rows = found.map(toCr);
  const inc = query.include || [];
  const crIds = rows.map((c) => c.id);
  const [m, hist, docs] = await Promise.all([
    moneyFor(rows),
    inc.includes('history') && crIds.length ? CrHistory.find({ cr_id: { $in: crIds } }).sort({ at: 1, _id: 1 }).select('cr_id text at').rows() : null,
    inc.includes('documents') ? documentsService.listForMany('cr', crIds) : null,
  ]);
  const histOf = {};
  (hist || []).forEach((h) => (histOf[h.cr_id] ||= []).push({ at: new Date(h.at).toISOString(), text: h.text }));
  return {
    rows: rows.map((c, i) => ({
      ...c,
      money: m[i],
      ...(inc.includes('history') && { history: histOf[c.id] || [] }),
      ...(docs && { documents: docs[c.id] }),
    })),
    meta: pg.meta(Number(n)),
  };
}

async function full(c, session = null) {
  const [history, docs, tasks, [mo]] = await Promise.all([
    CrHistory.find({ cr_id: c.id }).sort({ at: 1, _id: 1 }).select('text at').session(session).rows(),
    prepo.findDocuments('cr', c.id, session),
    Task.find({ cr_id: c.id }).sort({ created_at: 1, _id: 1 }).select('title assignee_id status estimate_hours').session(session).rows(),
    moneyFor([c], session),
  ]);
  return {
    ...c,
    history: history.map((h) => ({ at: new Date(h.at).toISOString(), text: h.text })),
    documents: docs.map(toDocument),
    boardTasks: tasks.map((t) => ({ id: t.id, title: t.title, assigneeId: t.assignee_id, status: t.status, estimateHours: Number(t.estimate_hours) })),
    money: mo,
  };
}

export async function detail(user, id) {
  return full(await visibleCr(user, id));
}

export async function printHtml(user, id) {
  const c = await full(await visibleCr(user, id));
  const [project, members] = await Promise.all([prepo.findProject(c.projectId), prepo.findMembers()]);
  return printCrHtml(c, { project, members });
}

/* ───────────── saveCr ───────────── */

/** History writer: lines get strictly increasing timestamps so their order is stable. */
function historian(crId, session = null) {
  const base = Date.now();
  let k = 0;
  const lines = [];
  return {
    add: (text) => lines.push({ cr_id: crId, text, at: new Date(base + k++) }),
    flush: () => (lines.length ? CrHistory.insertMany(lines.splice(0), { session }) : null),
  };
}

async function validateTarget(projectId, target, session = null) {
  if (target && target !== 'new') {
    const m = await Milestone.exists({ id: target, project_id: projectId }).session(session);
    if (!m) throw unprocessable('Pick a milestone of this project.');
  }
}

async function assertMembers(ids, session = null) {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (!uniq.length) return;
  const found = await Member.distinct('_id', { _id: { $in: uniq } }).session(session);
  const missing = uniq.filter((x) => !found.includes(x));
  if (missing.length) throw unprocessable(`Unknown team member: ${missing.join(', ')}`);
}

/** Normalise the editable fields exactly like saveCr. */
function editable(m) {
  if (!m.title.trim()) throw unprocessable('Give the change request a title.');
  if (!(+m.hours > 0)) throw unprocessable('Estimate the hours this change needs.');
  const tks = (m.tasks || []).filter((t) => t.title.trim()).map((t) => ({ title: t.title.trim(), assigneeId: t.assigneeId || '', hours: +t.hours || 0 }));
  const team = Array.from(new Set((m.team || []).concat(tks.map((t) => t.assigneeId).filter(Boolean))));
  return {
    title: m.title.trim(), description: m.description.trim(), requested_by: m.requestedBy, requested_by_name: m.requestedByName.trim(),
    hours: +m.hours, rate: +m.rate || 0, amount: Math.round(+m.hours * (+m.rate || 0)), extra_days: Math.max(0, Math.round(+m.extraDays || 0)),
    priority: m.priority, target: m.target || 'new', team, tasks: toTasks(tks),
  };
}

const estimateLine = (row, cur) => `Estimated ${row.hours}h · ${money(row.amount, cur)}${row.extra_days ? ` · +${row.extra_days} days` : ' · no change to due date'}`;

export async function create(user, b) {
  const id = await tx(async (session) => {
    const p = await prepo.findProject(b.projectId, session);
    if (!p || !(await canSee(user, p.id))) throw notFound('Project');
    if (!isPMof(user, p)) throw forbidden("Only the project's PM can change this");
    await prepo.lockProject(p.id, session);
    const rate = b.rate === undefined ? crRate(await prepo.findMilestones([p.id], session), p) : b.rate;
    const row = editable({ ...b, rate });
    await validateTarget(p.id, row.target, session);
    await assertMembers(row.team, session);
    const cur = await prepo.currency(session);
    // Next number of this project; the unique (project_id, n) index turns a concurrent duplicate into a 409.
    const last = await ChangeRequest.findOne({ project_id: p.id }).sort({ n: -1 }).select('n').session(session).rows();
    const n = (last ? last.n : 0) + 1;
    const crId = `CR-${p.id.slice(3)}-${n}`;
    const now = new Date();
    const send = !!b.send;
    await ChangeRequest.insertMany([{
      id: crId, project_id: p.id, n, ...row, status: send ? 'Sent to client' : 'Draft', raised_at: now, sent_at: send ? now : null,
    }], { session });
    const h = historian(crId, session);
    h.add(b.requestedBy === 'Client' ? `Raised by ${b.requestedByName.trim() || p.client}` : `Draft created by ${b.requestedByName.trim() || 'PM'}`);
    h.add(estimateLine(row, cur));
    if (send) h.add('Sent to client for approval');
    await h.flush();
    return crId;
  });
  const dto = await detail(user, id);
  return b.send ? withClientEmail(dto) : dto;
}

/** After a CR is sent to the client: email them (when CLIENT_EMAILS=true) and report it on the DTO. */
async function withClientEmail(dto, message) {
  const clientEmail = await emailCrToClient(dto);
  return { ...dto, clientEmail, ...(message !== undefined ? { message: message + clientMailNote(clientEmail) } : {}) };
}

/**
 * saveCr (edit). Draft and "Sent to client" CRs can be edited; `send` sends a draft, or re-sends an
 * already-sent CR after edits (client emailed again when CLIENT_EMAILS=true). Once approved / rejected
 * the CR is locked — only documents can change.
 */
export async function update(user, id, b) {
  let sentNow = false;
  await tx(async (session) => {
    const { c } = await pmCr(user, id, session);
    const locked = !['Draft', 'Sent to client'].includes(c.status);
    const { send, ...fields } = b;
    if (locked) {
      if (Object.keys(fields).length || send) throw unprocessable(LOCKED_MSG);
      return;
    }
    const row = editable({ ...c, ...fields });
    await validateTarget(c.projectId, row.target, session);
    await assertMembers(row.team, session);
    const h = historian(id, session);
    h.add(estimateLine(row, await prepo.currency(session)));
    if (send && c.status === 'Draft') {
      Object.assign(row, { status: 'Sent to client', sent_at: new Date() });
      h.add('Sent to client for approval');
      sentNow = true;
    } else if (send && c.status === 'Sent to client') {
      row.sent_at = new Date();
      h.add('Updated and re-sent to client');
      sentNow = true;
    }
    // Conditional on the status read above, so a concurrent approval can't be overwritten by this edit.
    const { matchedCount } = await ChangeRequest.updateOne({ id, status: c.status }, { $set: row }, { session });
    if (!matchedCount) throw unprocessable(LOCKED_MSG);
    await h.flush();
  });
  const dto = await detail(user, id);
  return sentNow ? withClientEmail(dto) : dto;
}

export async function remove(user, id) {
  const removeFiles = await tx(async (session) => {
    const { c } = await pmCr(user, id, session);
    if (!['Draft', 'Rejected'].includes(c.status)) throw unprocessable('Only draft or rejected change requests can be deleted.');
    const { deletedCount } = await ChangeRequest.deleteOne({ id, status: { $in: ['Draft', 'Rejected'] } }, { session });
    if (!deletedCount) throw unprocessable('Only draft or rejected change requests can be deleted.');
    // Former FKs: cr_history.cr_id CASCADE; milestones.cr_id / tasks.cr_id SET NULL.
    await CrHistory.deleteMany({ cr_id: id }, { session });
    await Milestone.updateMany({ cr_id: id }, { cr_id: null }, { session });
    await Task.updateMany({ cr_id: id }, { cr_id: null }, { session });
    return removeDocuments('cr', id, session);
  });
  await removeFiles();
}

export async function addDocuments(user, id, files, kind) {
  return tx(async (session) => {
    await pmCr(user, id, session);
    return attachDocuments('cr', id, files, user, session, kind);
  });
}

/* ───────────── crAct ───────────── */

const ALLOWED_FROM = {
  send: ['Draft'],
  approve: ['Draft', 'Sent to client'],
  reject: ['Draft', 'Sent to client'],
  start: ['Approved'],
  done: ['Approved', 'In progress'],
};

/**
 * Apply an action to a CR (shared by the PM endpoint and the client portal), inside the caller's
 * transaction `session`. act: send | approve | reject | start | done; via: 'pm' | 'portal'.
 * Returns the flash message.
 *
 * Every read happens first; the first write is a status change conditional on the status that was
 * read, so two concurrent decisions on the same CR can't both apply (the loser gets the same 422 as
 * a stale action). Only then are the milestone, project, team and board tasks updated.
 */
export async function applyDecision(c, p, act, { note, signer, via = 'pm' } = {}, session = null) {
  const nt = (note || '').trim();
  const now = new Date();
  const h = historian(c.id, session);
  const row = {};
  let msg = '';
  if (!ALLOWED_FROM[act].includes(c.status)) throw unprocessable(`Can't ${act} a change request that is ${c.status}.`);

  /** Conditional status change; throws the stale-action 422 when another decision got there first. */
  const claim = async () => {
    const { matchedCount } = await ChangeRequest.updateOne({ id: c.id, status: c.status }, { $set: row }, { session });
    if (!matchedCount) {
      const fresh = await ChangeRequest.findOne({ id: c.id }).select('status').session(session).rows();
      throw unprocessable(`Can't ${act} a change request that is ${fresh ? fresh.status : c.status}.`);
    }
  };

  if (act === 'send') {
    Object.assign(row, { status: 'Sent to client', sent_at: now });
    await claim();
    h.add('Sent to client for approval');
    msg = `${c.id} sent to client`;
  } else if (act === 'approve') {
    const pmName = (await Member.findOne({ id: p.pmId }).select('name').session(session).rows())?.name || 'PM';
    const sig = {
      name: signer.name.trim(), title: (signer.title || '').trim() || null, at: now, note: nt,
      via: via === 'portal' ? 'Typed signature in client portal' : `Recorded by ${pmName} (client approved by email / call)`,
    };
    Object.assign(row, { status: 'Approved', decided_at: now, sig_name: sig.name, sig_title: sig.title, sig_at: now, sig_via: sig.via, sig_note: nt || null });
    if (nt) h.add(`Client comment · ${nt}`);

    // Milestone: a new CR milestone (PR-101-CR-101-1, next n), or extra hours on the target milestone.
    const ms = await Milestone.find({ project_id: p.id }).select('n due_date').session(session).rows();
    const T = todayN();
    const newMilestone = !c.target || c.target === 'new' || !ms.some((m) => m.id === c.target);
    const msId = newMilestone ? `${p.id}-${c.id}` : c.target;
    const msDue = newMilestone ? ds(Math.max(dn(p.dueDate), T) + (c.extraDays || 0)) : ms.find((m) => m.id === msId).due_date || p.dueDate;
    row.milestone_id = msId;

    // Project team and allocations from the work breakdown.
    const tk = (c.tasks || []).filter((t) => t.title);
    const addA = {};
    tk.forEach((t) => { if (t.assigneeId) addA[t.assigneeId] = (addA[t.assigneeId] || 0) + (+t.hours || 0); });
    const newTeam = Array.from(new Set((c.team || []).concat(Object.keys(addA))));
    const onTeam = new Set(p.team.map((t) => t.memberId));
    const joiners = newTeam.filter((mid) => !onTeam.has(mid));
    const lastSeat = joiners.length
      ? await ProjectMember.findOne({ project_id: p.id }).sort({ position: -1 }).select('position').session(session).rows()
      : null;
    const cur = await prepo.currency(session);

    await claim();
    if (newMilestone) {
      await Milestone.insertMany([{
        id: msId, project_id: p.id, n: ms.reduce((x, m) => Math.max(x, m.n), 0) + 1, name: `CR: ${c.title}`, alloc_hours: c.hours, due_date: msDue, status: 'Not started', cr_id: c.id,
      }], { session });
    } else {
      await Milestone.updateOne({ id: msId }, { $inc: { alloc_hours: c.hours } }, { session });
    }
    // The approved CR's hours are added to the project's hours budget (when it has one).
    await Project.updateOne({ id: p.id, budget_hours: { $ne: null } }, { $inc: { budget_hours: c.hours } }, { session });
    if (joiners.length) {
      const pos = (lastSeat ? lastSeat.position : -1) + 1;
      await ProjectMember.insertMany(joiners.map((mid, i) => ({ project_id: p.id, member_id: mid, alloc_hours: 0, position: pos + i })), { session });
    }
    for (const [mid, hrs] of Object.entries(addA)) {
      await ProjectMember.updateOne({ project_id: p.id, member_id: mid }, { $inc: { alloc_hours: hrs } }, { session });
    }
    // Project: contract value and due date.
    await Project.updateOne({ id: p.id }, { $inc: { value: c.amount || 0 }, $set: { due_date: ds(dn(p.dueDate) + (c.extraDays || 0)) } }, { session });

    // Board tasks from the work breakdown (created_at steps by 1 ms so they list in breakdown order).
    const boardTasks = [];
    for (const [i, t] of tk.entries()) {
      boardTasks.push({
        id: await nextId('task'), project_id: p.id, milestone_id: msId, title: t.title, description: `From ${c.id} · ${c.title}`,
        assignee_id: t.assigneeId || null, status: 'To do', priority: c.priority || 'Medium', due_date: msDue, estimate_hours: +t.hours || 0,
        checklist: [], cr_id: c.id, log: [{ d: now.toISOString(), t: `Created from ${c.id}` }], created_at: new Date(now.getTime() + i),
      });
    }
    if (boardTasks.length) await Task.insertMany(boardTasks, { session });
    h.add(`Approved by ${sig.name} · ${sig.via}`);
    h.add(`+${c.hours}h added to the budget · +${money(c.amount || 0, cur)} contract value${c.extraDays ? ` · due date moved by ${c.extraDays} days` : ''}${tk.length ? ` · ${tk.length} task${tk.length > 1 ? 's' : ''} created on the board` : ''}`);
    msg = `${c.id} approved · ${tk.length ? `${tk.length} tasks created, ` : ''}hours, value and timeline updated`;
  } else if (act === 'reject') {
    Object.assign(row, { status: 'Rejected', decided_at: now, note: nt });
    await claim();
    h.add((via === 'portal' ? 'Rejected by client in portal' : 'Marked rejected') + (nt ? ` · ${nt}` : ''));
    msg = `${c.id} rejected`;
  } else if (act === 'start') {
    row.status = 'In progress';
    await claim();
    h.add('Work started');
    if (c.milestoneId) await Milestone.updateOne({ id: c.milestoneId, cr_id: { $ne: null } }, { status: 'In progress' }, { session });
    msg = `Work started on ${c.id}`;
  } else if (act === 'done') {
    Object.assign(row, { status: 'Done', done_at: now });
    await claim();
    h.add('Marked done');
    if (c.milestoneId) await Milestone.updateOne({ id: c.milestoneId, cr_id: { $ne: null } }, { status: 'Done' }, { session });
    msg = `${c.id} marked done`;
  }
  await h.flush();
  return msg;
}

/** POST :id/actions (PM). Approval recorded by the PM needs the client signer's name. */
export async function act(user, id, { act: action, note, signer }) {
  if (action === 'approve' && (!signer || (signer.name || '').trim().length < 3)) {
    throw unprocessable('Enter the name of the client person who approved (needed for the approval record).');
  }
  const message = await tx(async (session) => {
    const { c, p } = await pmCr(user, id, session);
    return applyDecision(c, p, action, { note, signer, via: 'pm' }, session);
  });
  const dto = await detail(user, id);
  return action === 'send' ? withClientEmail(dto, message) : { ...dto, message };
}
