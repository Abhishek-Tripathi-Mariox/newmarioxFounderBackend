/**
 * Mongo reads and writes for projects, milestones, members, links, logs and portal lookups, plus the
 * ON DELETE behaviour of projects and milestones (docs/MONGO.md → "Foreign keys").
 * Every helper takes the transaction `session` as its last parameter (null = no transaction).
 */
import {
  ActiveTimer, Bug, BugEvent, ChangeRequest, CrHistory, Document, Member, Milestone, MilestoneMember, Project,
  ProjectCredential, ProjectFollowUp, ProjectIntegration, ProjectLink, ProjectMember, Setting, Task, TeamTask, TimeLog,
} from '../../db/models/index.js';
import { TEXT_ORDER } from '../../db/modelKit.js';
import { restrictTo } from '../../core/scope.js';
import { unprocessable } from '../../core/errors.js';
import { documentsService } from '../documents/documents.service.js';
import { toProject, toMilestone, toMember, toLog } from './projects.mapper.js';

const fmtH = (x) => `${Math.round((+x || 0) * 10) / 10}h`;

const PROJECT_COLS = 'name client services status pm_member_id start_date due_date expected_delivery_date value hue priority brief client_email budget_hours status_reason status_note status_note_at portal_on portal_token created_at updated_at';

/** Projects (optionally limited to `ids`) with team + links attached, ordered by id. */
export async function findProjects(ids, session = null) {
  const rows = await Project.find(restrictTo({}, '_id', ids)).select(PROJECT_COLS).sort({ _id: 1 }).session(session).rows();
  return attachTeamAndLinks(rows, session);
}

export async function findProject(id, session = null) {
  const row = await Project.findOne({ id }).select(PROJECT_COLS).session(session).rows();
  if (!row) return null;
  return (await attachTeamAndLinks([row], session))[0];
}

/**
 * Serialise concurrent writers on one project inside a transaction (replaces `SELECT … FOR UPDATE`):
 * the write makes any other transaction touching the same project document abort and retry.
 * Without a transaction (standalone server) there is nothing to serialise.
 */
export async function lockProject(id, session = null) {
  if (!session) return;
  await Project.updateOne({ id }, { $inc: { lock_version: 1 } }, { session, timestamps: false });
}

async function attachTeamAndLinks(rows, session) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [team, links] = await Promise.all([
    ProjectMember.find({ project_id: { $in: ids } }).sort({ project_id: 1, position: 1, member_id: 1 }).session(session).rows(),
    ProjectLink.find({ project_id: { $in: ids } }).sort({ _id: 1 }).session(session).rows(),
  ]);
  return rows.map((r) => toProject(r, team.filter((t) => t.project_id === r.id), links.filter((l) => l.project_id === r.id)));
}

async function withTeams(rows, session) {
  if (!rows.length) return [];
  const mm = await MilestoneMember.find({ milestone_id: { $in: rows.map((r) => r.id) } }).sort({ member_id: 1 }).session(session).rows();
  return rows.map((r) => {
    const mine = mm.filter((x) => x.milestone_id === r.id);
    return toMilestone(r, mine.map((x) => x.member_id), Object.fromEntries(mine.map((x) => [x.member_id, Number(x.alloc_hours) || 0])));
  });
}

/** Milestones of the given projects (all when null), ordered by project then n. */
export async function findMilestones(projectIds, session = null) {
  const rows = await Milestone.find(restrictTo({}, 'project_id', projectIds)).sort({ project_id: 1, n: 1 }).session(session).rows();
  return withTeams(rows, session);
}

export async function findMilestone(id, session = null) {
  const r = await Milestone.findOne({ id }).session(session).rows();
  return r ? (await withTeams([r], session))[0] : null;
}

/** Normalise a milestone team input (ids or {memberId, hours}) → [{id, hours}] (last entry wins). */
export function normTeam(list = []) {
  const map = new Map();
  for (const x of list) {
    if (typeof x === 'string') map.set(x, map.has(x) ? map.get(x) : 0);
    else map.set(x.memberId, Math.max(0, +x.hours || 0));
  }
  return [...map].map(([id, hours]) => ({ id, hours }));
}

/**
 * Validate a milestone team input without writing anything (so callers can check every rule before
 * their first write). One person on the milestone gets all of its hours; everyone's hours together
 * may not exceed the milestone's; every member must exist.
 * @returns {Promise<Array<{id: string, hours: number}>>} the normalised entries
 */
export async function prepareMilestoneTeam(team, msHours, session = null) {
  const entries = normTeam(team);
  if (entries.length === 1 && msHours != null) entries[0].hours = Math.max(0, +msHours || 0);
  if (msHours != null) {
    const sum = entries.reduce((x, e) => x + e.hours, 0);
    if (sum > msHours + 1e-9) {
      throw unprocessable(`Team hours (${fmtH(sum)}) are more than the milestone's ${fmtH(msHours)}. Reduce someone's hours or raise the milestone hours.`);
    }
  }
  const ids = entries.map((e) => e.id);
  if (ids.length) {
    const known = await Member.distinct('_id', { _id: { $in: ids } }).session(session);
    const bad = ids.filter((x) => !known.includes(x));
    if (bad.length) throw unprocessable(`Unknown team member: ${bad.join(', ')}`);
  }
  return entries;
}

/**
 * Replace a milestone's team with already validated entries (see prepareMilestoneTeam). Members not
 * yet on the project team join it (0 hours allocated), after the last position.
 */
export async function writeMilestoneTeam(projectId, milestoneId, entries, session = null) {
  if (entries.length) {
    const onTeam = await ProjectMember.find({ project_id: projectId }).select('member_id position').session(session).rows();
    const known = new Set(onTeam.map((t) => t.member_id));
    const join = entries.map((e) => e.id).filter((x) => !known.has(x));
    if (join.length) {
      const max = onTeam.reduce((m, t) => Math.max(m, t.position), -1);
      await ProjectMember.insertMany(join.map((mid, i) => ({ project_id: projectId, member_id: mid, alloc_hours: 0, position: max + 1 + i })), { session });
    }
  }
  await MilestoneMember.deleteMany({ milestone_id: milestoneId }, { session });
  if (entries.length) await MilestoneMember.insertMany(entries.map((e) => ({ milestone_id: milestoneId, member_id: e.id, alloc_hours: e.hours })), { session });
}

/** Validate then replace a milestone's team (prepareMilestoneTeam + writeMilestoneTeam). */
export async function setMilestoneTeam(projectId, milestoneId, team, msHours, session = null) {
  const entries = await prepareMilestoneTeam(team, msHours, session);
  await writeMilestoneTeam(projectId, milestoneId, entries, session);
}

export async function findMembers(session = null) {
  return (await Member.find({}).sort({ name: 1 }).collation(TEXT_ORDER).session(session).rows()).map(toMember);
}

/** Time logs of the given projects (all when null), newest first. */
export async function findLogs(projectIds, session = null) {
  const rows = await TimeLog.find(restrictTo({}, 'project_id', projectIds))
    .select('member_id project_id milestone_id day hours note source created_at')
    .sort({ day: -1, created_at: -1 }).session(session).rows();
  return rows.map(toLog);
}

/** { project_id: count } of the documents matching `filter`. */
async function countByProject(Model, filter, session) {
  const rows = await Model.aggregate([{ $match: filter }, { $group: { _id: '$project_id', n: { $sum: 1 } } }]).session(session);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/** Per-project counts used by the health score: blocked tasks and open critical bugs. */
export async function healthCounts(projectIds, session = null) {
  const [blocked, critical] = await Promise.all([
    countByProject(Task, restrictTo({ status: 'Blocked' }, 'project_id', projectIds), session),
    countByProject(Bug, restrictTo({ severity: 'Critical', status: { $nin: ['Closed', 'Fixed'] } }, 'project_id', projectIds), session),
  ]);
  return { blocked, critical };
}

export async function findOpenTasks(projectIds, session = null) {
  const rows = await Task.find(restrictTo({ status: { $ne: 'Done' } }, 'project_id', projectIds))
    .select('project_id assignee_id status due_date estimate_hours').session(session).rows();
  return rows.map((t) => ({ id: t.id, projectId: t.project_id, assigneeId: t.assignee_id, status: t.status, dueDate: t.due_date, estimateHours: Number(t.estimate_hours) }));
}

/** Document rows of one entity, newest first. */
export const findDocuments = (entityType, entityId, session = null) => Document.find({ entity_type: entityType, entity_id: entityId }).sort({ created_at: -1 }).session(session).rows();

/** `{ id }` of the project whose portal is ON with this token, or null. */
export const findProjectByToken = (token, session = null) => Project.findOne({ portal_token: token, portal_on: true }).select('_id').session(session).rows();

/** Currency setting (INR default) used in money labels. */
export async function currency(session = null) {
  const r = await Setting.findOne({ key: 'currency' }).select('value').session(session).rows();
  const v = r && r.value;
  return v === 'USD' ? 'USD' : 'INR';
}

/* ───────────── ON DELETE behaviour (no foreign keys in MongoDB) ───────────── */

/**
 * What deleting a milestone did to its dependants in Postgres: milestone_members CASCADE;
 * change_requests / tasks / bugs / time_logs / active_timers.milestone_id SET NULL.
 */
export async function removeMilestone(milestoneId, session = null) {
  const opts = { session };
  await MilestoneMember.deleteMany({ milestone_id: milestoneId }, opts);
  for (const Model of [ChangeRequest, Task, Bug, TimeLog, ActiveTimer]) {
    await Model.updateMany({ milestone_id: milestoneId }, { milestone_id: null }, opts);
  }
  await Milestone.deleteOne({ id: milestoneId }, opts);
}

/**
 * Delete a project and everything that hung off it through ON DELETE CASCADE in Postgres:
 * project_members, project_links, milestones (→ milestone_members), change_requests (→ cr_history),
 * tasks (→ active_timers.task_id), bugs (→ bug_events), time_logs, active_timers, project_follow_ups,
 * project_integrations (→ project_credentials); team_tasks.project_id is SET NULL. The documents of
 * the project, its bugs and its change requests are removed too.
 * @returns {Promise<() => Promise<void>>} removes the stored files — call it after the commit
 */
export async function removeProject(projectId, session = null) {
  const opts = { session };
  const byProject = { project_id: projectId };
  const [milestoneIds, crIds, taskIds, bugIds, integrationIds] = await Promise.all([
    Milestone.distinct('_id', byProject).session(session),
    ChangeRequest.distinct('_id', byProject).session(session),
    Task.distinct('_id', byProject).session(session),
    Bug.distinct('_id', byProject).session(session),
    ProjectIntegration.distinct('_id', byProject).session(session),
  ]);
  const fileCleanups = [
    await documentsService.removeForEntity('project', projectId, session),
    ...(await Promise.all(crIds.map((id) => documentsService.removeForEntity('cr', id, session)))),
    ...(await Promise.all(bugIds.map((id) => documentsService.removeForEntity('bug', id, session)))),
  ];
  await MilestoneMember.deleteMany({ milestone_id: { $in: milestoneIds } }, opts);
  await CrHistory.deleteMany({ cr_id: { $in: crIds } }, opts);
  await BugEvent.deleteMany({ bug_id: { $in: bugIds } }, opts);
  await ProjectCredential.deleteMany({ integration_id: { $in: integrationIds } }, opts);
  await ActiveTimer.deleteMany({ $or: [byProject, { task_id: { $in: taskIds } }] }, opts);
  for (const Model of [ProjectMember, ProjectLink, Milestone, ChangeRequest, Task, Bug, TimeLog, ProjectFollowUp, ProjectIntegration]) {
    await Model.deleteMany(byProject, opts);
  }
  await TeamTask.updateMany(byProject, { project_id: null }, opts);
  await Project.deleteOne({ id: projectId }, opts);
  return async () => { for (const cleanup of fileCleanups) await cleanup(); };
}
