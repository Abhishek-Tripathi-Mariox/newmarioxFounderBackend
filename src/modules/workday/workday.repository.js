/**
 * MongoDB reads and writes for workday / live / attendance / reports (the raw-data reads shared with
 * state.service — `events`, `timers`, `presenceMap` — live in state.repository.js).
 * Every helper takes `session` as its last parameter (default null): see docs/MONGO.md "Transactions".
 * Tables owned by other modules (members, projects, tasks, leads …) are read through their models.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { TEXT_ORDER } from '../../db/modelKit.js';
import { conflict } from '../../core/errors.js';
import {
  ActiveTimer, ActivityFeed, AttendanceEvent, ChangeRequest, FollowUp, Lead, LeadActivity, Member, Milestone,
  MilestoneMember, Presence, Project, ProjectMember, SalesOwner, ShiftReport, Task, TimeLog,
} from '../../db/models/index.js';

const at = (t) => new Date(t);
/** Map of project id → project row (only the given columns). */
async function projectsById(ids, columns, session = null) {
  const rows = await Project.find({ id: { $in: [...new Set(ids)] } }).select(columns).session(session).rows();
  return new Map(rows.map((p) => [p.id, p]));
}

/* ───────────── Per-person lock ───────────── */

/** How long a lock is held at most (a crashed holder releases it by expiry). */
const LOCK_LEASE_MS = 30e3;
/** How long a second request waits for the lock before giving up. */
const LOCK_WAIT_MS = 10e3;
const LOCK_RETRY_MS = 20;
const DUPLICATE_KEY = 11000;

/**
 * Try to take `pid`'s workday lock: one conditional write on their presence document that only
 * matches when no one holds an unexpired lease. Returns `{ token, created }` or null when busy.
 * When the document doesn't exist yet the upsert creates it; a concurrent creator makes one of the
 * two upserts fail with a duplicate key, which counts as busy.
 */
async function tryLock(pid) {
  const now = new Date();
  const token = randomUUID();
  try {
    const res = await Presence.findOneAndUpdate(
      { person_id: pid, $or: [{ locked_until: null }, { locked_until: { $lte: now } }] },
      { $set: { lock_token: token, locked_until: new Date(now.getTime() + LOCK_LEASE_MS) }, $setOnInsert: { last_activity_at: now } },
      { upsert: true, includeResultMetadata: true },
    );
    return { token, created: !res.lastErrorObject?.updatedExisting };
  } catch (err) {
    if (err.code === DUPLICATE_KEY) return null;
    throw err;
  }
}

/**
 * Run `fn()` while holding `pid`'s workday lock (replaces Postgres' pg_advisory_xact_lock): check-in /
 * out, breaks, timers and the end-of-shift report of one person run one at a time, so two quick
 * clicks can never both see "not checked in" and write two check-ins. The lock is taken outside any
 * transaction (it must also work on a standalone server) and released when `fn` settles.
 * If `fn` fails and the lock created the presence document, the document is removed again, so a
 * failed action leaves no trace (as the rolled-back Postgres transaction did).
 */
export async function withPersonLock(pid, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lock = await tryLock(pid);
  while (!lock) {
    if (Date.now() > deadline) throw conflict('Another change to this workday is still in progress. Try again.');
    await sleep(LOCK_RETRY_MS);
    lock = await tryLock(pid);
  }
  let failed = true;
  try {
    const out = await fn();
    failed = false;
    return out;
  } finally {
    const mine = { person_id: pid, lock_token: lock.token };
    if (failed && lock.created) await Presence.deleteOne(mine);
    else await Presence.updateOne(mine, { $set: { lock_token: null, locked_until: null } });
  }
}

/* ───────────── Attendance, feed, presence, timers ───────────── */

export const insertEvent = (pid, kind, t, meta = {}, session = null) => AttendanceEvent.insertMany([{ person_id: pid, kind, at: at(t), meta }], { session });

/** Last attendance event per person (ever) → { pid: ms }. */
export async function lastTracked() {
  const rows = await AttendanceEvent.aggregate([{ $group: { _id: '$person_id', at: { $max: '$at' } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, new Date(r.at).getTime()]));
}

export const feed = (pid, kind, text, t, leadId = null, session = null) => ActivityFeed.insertMany([{ person_id: pid, kind, text, at: at(t), lead_id: leadId }], { session });

export const touchPresence = (pid, t = Date.now(), session = null) => Presence.updateOne({ person_id: pid }, { $set: { last_activity_at: at(t) } }, { upsert: true, session });

/** Running timers (one person, or everyone) with `project_name` (null when the project is gone). */
async function withProjectName(timers, session = null) {
  const names = await projectsById(timers.map((t) => t.project_id), 'name', session);
  return timers.map((t) => ({ ...t, project_name: names.get(t.project_id)?.name ?? null }));
}
export async function timer(pid, session = null) {
  const row = await ActiveTimer.findOne({ person_id: pid }).session(session).rows();
  return row ? (await withProjectName([row], session))[0] : undefined;
}
export async function timers() {
  return withProjectName(await ActiveTimer.find().rows());
}
export const deleteTimer = (pid, session = null) => ActiveTimer.deleteOne({ person_id: pid }, { session });
export const insertTimer = (row, session = null) => ActiveTimer.insertMany([row], { session });

/* ───────────── People, tasks, projects ───────────── */

/** Delivery members + sales owners (active; founders' lead-owner profiles aren't sales staff), like the frontend `people()`. */
export async function people(session = null) {
  const [members, owners] = await Promise.all([
    Member.find({ active: true }).sort({ name: 1 }).collation(TEXT_ORDER).select('name role_title team hue shift_hours').session(session).rows(),
    SalesOwner.find({ active: true, founder: { $ne: true } }).sort({ name: 1 }).collation(TEXT_ORDER).select('name hue').session(session).rows(),
  ]);
  return members.map((m) => ({ id: m.id, name: m.name, role: `${m.role_title} · ${m.team}`, team: m.team, hue: m.hue, sales: false, shift: Number(m.shift_hours) || 8 }))
    .concat(owners.map((o) => ({ id: o.id, name: o.name, role: 'Sales', team: 'Sales', hue: o.hue, sales: true, shift: 8 })));
}

export const member = (id, session = null) => Member.findOne({ id }).session(session).rows();
export const salesOwner = (id, session = null) => SalesOwner.findOne({ id }).session(session).rows();

export const task = (id) => Task.findOne({ id }).select('project_id milestone_id title assignee_id status').rows();

/** Open tasks with an assignee (on an existing project), by id, with `project_name`. */
export async function openAssignedTasks() {
  const tasks = await Task.find({ assignee_id: { $ne: null }, status: { $ne: 'Done' } }).sort({ _id: 1 }).select('title assignee_id project_id').rows();
  const names = await projectsById(tasks.map((t) => t.project_id), 'name');
  return tasks.filter((t) => names.has(t.project_id))
    .map((t) => ({ id: t.id, title: t.title, assignee_id: t.assignee_id, project_name: names.get(t.project_id).name }));
}

export const projects = () => Project.find().select('name client status pm_member_id').rows();
export const projectTeam = () => ProjectMember.find().select('project_id member_id').rows();
/** Ids of the given projects that exist. */
export const existingProjectIds = (ids, session = null) => Project.distinct('_id', { _id: { $in: ids } }).session(session);
export const milestonesOf = (projectIds, session = null) => Milestone.find({ project_id: { $in: projectIds } })
  .sort({ project_id: 1, n: 1 }).select('project_id n status').session(session).rows();
/** Projects where `pid` is on a milestone team. */
export async function milestoneProjectIdsOf(pid) {
  const milestoneIds = await MilestoneMember.distinct('milestone_id', { member_id: pid });
  return Milestone.distinct('project_id', { _id: { $in: milestoneIds } });
}

/* ───────────── Time logs and shift reports ───────────── */

export function logsOn(day, pid = null) {
  return TimeLog.find({ day, ...(pid ? { member_id: pid } : {}) }).sort({ created_at: 1, _id: 1 })
    .select('member_id project_id milestone_id hours note').rows();
}
export const insertLog = (row, session = null) => TimeLog.insertMany([row], { session });
export const deleteLogsOn = (pid, day, session = null) => TimeLog.deleteMany({ member_id: pid, day }, { session });

/** Shift reports of `pids` with fromDay ≤ day < toDay ('YYYY-MM-DD'). */
export const reportsIn = (pids, fromDay, toDay) => ShiftReport.find({ person_id: { $in: pids }, day: { $gte: fromDay, $lt: toDay } }).rows();
/** One report per person per day: replaces the columns given (insert … on conflict merge). */
export const upsertReport = (row, session = null) => ShiftReport.updateOne({ person_id: row.person_id, day: row.day }, { $set: row }, { upsert: true, session });

/* ───────────── Sales: leads, lead activity, follow-ups ───────────── */

/** Lead activity since `from` (owner = lead owner) plus live-feed lines that reference a lead (owner = who did it). */
export async function leadActsSince(from, session = null) {
  const [acts, fd] = await Promise.all([
    LeadActivity.find({ at: { $gte: at(from) } }).select('at kind text lead_id').session(session).rows(),
    ActivityFeed.find({ at: { $gte: at(from) }, lead_id: { $ne: null } }).select('at kind text lead_id person_id').session(session).rows(),
  ]);
  const leads = await Lead.find({ id: { $in: [...new Set([...acts, ...fd].map((a) => a.lead_id))] } }).select('company owner_id').session(session).rows();
  const byId = new Map(leads.map((l) => [l.id, l]));
  const row = (a, owner, fromFeed) => ({ t: new Date(a.at).getTime(), kind: a.kind, text: a.text, leadId: a.lead_id, company: byId.get(a.lead_id).company, owner, fromFeed });
  return acts.filter((a) => byId.has(a.lead_id)).map((a) => row(a, byId.get(a.lead_id).owner_id, false))
    .concat(fd.filter((a) => byId.has(a.lead_id)).map((a) => row(a, a.person_id, true)));
}

export const teamFeedSince = (from) => ActivityFeed.find({ lead_id: null, at: { $gte: at(from) } }).sort({ at: -1 }).limit(500)
  .select('person_id kind text at').rows();

export const followUpsFor = (owners) => FollowUp.find({ owner_id: { $in: owners } }).select('owner_id due_at done').rows();
/** `owner`'s follow-ups that are attached to a lead. */
export const leadFollowUpsOf = (owner) => FollowUp.find({ owner_id: owner, lead_id: { $ne: null } }).select('lead_id due_at done').rows();
export const newLeadsSince = (owner, from) => Lead.countDocuments({ owner_id: owner, created_at: { $gte: at(from) } });
export const leadsByIds = (ids, session = null) => Lead.find({ id: { $in: ids } }).select('company contact owner_id').session(session).rows();
export const insertLeadActivity = (row, session = null) => LeadActivity.insertMany([row], { session });
/** Is a follow-up still open for `leadId` with start ≤ due_at < end? */
export async function hasOpenFollowUp(leadId, start, end, session = null) {
  return !!(await FollowUp.exists({ lead_id: leadId, done: false, due_at: { $gte: start, $lt: end } }).session(session));
}
export const insertFollowUp = (row, session = null) => FollowUp.insertMany([row], { session });

/* ───────────── Live-now alerts ───────────── */

/** Client approvals given since `from`, with the project's client. */
export async function approvalsSince(from) {
  const ms = await Milestone.find({ approval_at: { $ne: null, $gte: at(from) }, approval_status: { $ne: null } }).select('name approval_status approval_at project_id').rows();
  const prj = await projectsById(ms.map((m) => m.project_id), 'client');
  return ms.filter((m) => prj.has(m.project_id)).map((m) => ({ name: m.name, approval_status: m.approval_status, approval_at: m.approval_at, client: prj.get(m.project_id).client }));
}

/** The 3 most recent "Changes requested" milestones not yet Done (latest approval first, unknown dates first like Postgres). */
export async function changesRequested() {
  const ms = await Milestone.find({ approval_status: 'Changes requested', status: { $ne: 'Done' } }).select('name approval_note approval_at project_id').rows();
  const prj = await projectsById(ms.map((m) => m.project_id), 'name client');
  const time = (m) => (m.approval_at == null ? Number.MAX_SAFE_INTEGER : new Date(m.approval_at).getTime());
  return ms.filter((m) => prj.has(m.project_id)).sort((a, b) => time(b) - time(a)).slice(0, 3)
    .map((m) => ({ name: m.name, approval_note: m.approval_note, project_id: m.project_id, project_name: prj.get(m.project_id).name, client: prj.get(m.project_id).client }));
}

export async function crsAwaiting() {
  const crs = await ChangeRequest.find({ status: 'Sent to client' }).select('title hours amount sent_at raised_at project_id').rows();
  const prj = await projectsById(crs.map((c) => c.project_id), 'client');
  return crs.filter((c) => prj.has(c.project_id)).map((c) => ({ ...c, client: prj.get(c.project_id).client }));
}

/** Active members on a Running project with no time logged on `day`, by name. */
export async function missingTimesheets(day) {
  const running = await Project.distinct('_id', { status: 'Running' });
  const [onRunning, logged] = await Promise.all([
    ProjectMember.distinct('member_id', { project_id: { $in: running } }),
    TimeLog.distinct('member_id', { day }),
  ]);
  return Member.find({ active: true, _id: { $in: onRunning, $nin: logged } }).sort({ name: 1 }).collation(TEXT_ORDER).select('name').rows();
}
