/**
 * MongoDB reads behind GET /founder/summary. Everyone's data (no user scope). Other modules'
 * collections are read through their models only. Joins are second queries + Maps (small lists).
 */
import { TEXT_ORDER } from '../../db/modelKit.js';
import {
  Bug, ChangeRequest, FollowUp, Lead, LeadActivity, LeadStage, Member, Milestone, Project, Quote, SalesOwner, ShiftReport,
  TeamTask, TimeLog, User,
} from '../../db/models/index.js';

const OPEN_BUG = ['Open', 'In progress', 'Retest', 'Reopened'];
const CLOSED_STAGES = ['Won', 'Lost'];

/** Postgres sum(numeric) is exact: round float sums back to the column's 2 decimals. */
const round2 = (n) => Math.round(n * 100) / 100;
/** Postgres ORDER BY … DESC puts NULLs first. */
const nullsFirstDesc = (field) => (a, b) => {
  const x = a[field] == null ? Infinity : new Date(a[field]).getTime();
  const y = b[field] == null ? Infinity : new Date(b[field]).getTime();
  return x === y ? 0 : x < y ? 1 : -1;
};

/** member id → name, for the given ids. */
async function memberNames(ids) {
  const rows = await Member.find({ id: { $in: [...new Set(ids.filter(Boolean))] } }).select('name').rows();
  return new Map(rows.map((m) => [m.id, m.name]));
}

/**
 * Won / lost leads with `closed_at`: the last "Stage: … → Won|Lost" activity of that lead
 * (its text ends with "→ <status>"), else the lead's updated_at.
 */
export async function closedLeads() {
  const leads = await Lead.find({ status: { $in: CLOSED_STAGES } }).select('status value owner_id updated_at').rows();
  const acts = await LeadActivity.find({ lead_id: { $in: leads.map((l) => l.id) }, kind: 'status' }).select('lead_id text at').rows();
  const statusOf = new Map(leads.map((l) => [l.id, l.status]));
  const lastClose = new Map();
  for (const a of acts) {
    if (!a.text.endsWith(`→ ${statusOf.get(a.lead_id)}`)) continue;
    const t = new Date(a.at).getTime();
    if (!(lastClose.get(a.lead_id) >= t)) lastClose.set(a.lead_id, t);
  }
  return leads.map((l) => ({ ...l, closed_at: lastClose.has(l.id) ? new Date(lastClose.get(l.id)) : l.updated_at }));
}

export const openLeads = () => Lead.find({ status: { $nin: CLOSED_STAGES } }).select('status owner_id value').rows();
export const leadsCreatedSince = (from) => Lead.countDocuments({ created_at: { $gte: new Date(from) } });
/** Open pipeline stage names, in board order. */
export async function openStageNames() {
  const rows = await LeadStage.find({ name: { $nin: CLOSED_STAGES } }).sort({ position: 1 }).select('name').rows();
  return rows.map((r) => r.name);
}
export const activeSalesOwners = () => SalesOwner.find({ active: true }).sort({ name: 1 }).collation(TEXT_ORDER).select('name hue').rows();
export const openFollowUps = () => FollowUp.find({ done: false }).select('owner_id due_at').rows();

/** sales owner id → { name, hue }, for the given ids (active or not). */
export async function ownersById(ids) {
  const rows = await SalesOwner.find({ id: { $in: [...new Set(ids.filter(Boolean))] } }).select('name hue').rows();
  return new Map(rows.map((o) => [o.id, o]));
}

/** lead id → company, for the given ids. */
async function leadCompanies(ids) {
  const rows = await Lead.find({ id: { $in: [...new Set(ids.filter(Boolean))] } }).select('company').rows();
  return new Map(rows.map((l) => [l.id, l.company]));
}

/** Open follow-ups due before `to` (overdue + due today), earliest first, with the lead's `company`. */
export async function followUpsDueBefore(to) {
  const rows = await FollowUp.find({ done: false, due_at: { $lt: new Date(to) } }).sort({ due_at: 1, _id: 1 })
    .select('type title lead_id owner_id due_at priority').rows();
  const companyOf = await leadCompanies(rows.map((f) => f.lead_id));
  return rows.map((f) => ({ ...f, company: companyOf.get(f.lead_id) ?? null }));
}

/** Leads created since `from`, newest first. */
export const leadsSince = (from) => Lead.find({ created_at: { $gte: new Date(from) } }).sort({ created_at: -1, _id: -1 })
  .select('company source owner_id value status created_at').rows();

/** Leads created since `from`, counted per source (no source → null), most first. */
export async function leadSourcesSince(from) {
  const rows = await Lead.aggregate([{ $match: { created_at: { $gte: new Date(from) } } }, { $group: { _id: '$source', n: { $sum: 1 } } }]);
  return rows.map((r) => ({ source: r._id ?? null, count: r.n }));
}

/** Change requests waiting on the client → { n, v } (count, total amount). */
export async function crsWaiting() {
  const [r] = await ChangeRequest.aggregate([{ $match: { status: 'Sent to client' } }, { $group: { _id: null, n: { $sum: 1 }, v: { $sum: '$amount' } } }]);
  return { n: r ? r.n : 0, v: r ? round2(r.v) : 0 };
}

export const openBugCount = () => Bug.countDocuments({ status: { $in: OPEN_BUG } });
/** Open bugs per severity → [{ severity, n }]. */
export async function openBugsBySeverity() {
  const rows = await Bug.aggregate([{ $match: { status: { $in: OPEN_BUG } } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]);
  return rows.map((r) => ({ severity: r._id, n: r.n }));
}

/** Change requests waiting on the client, longest waiting first, with `project_name`. */
export async function crsWaitingList() {
  const crs = await ChangeRequest.find({ status: 'Sent to client' }).select('project_id title amount sent_at raised_at').rows();
  const projects = await Project.find({ id: { $in: [...new Set(crs.map((c) => c.project_id))] } }).select('name').rows();
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const sentAt = (c) => new Date(c.sent_at || c.raised_at || 0).getTime();
  return crs.sort((a, b) => sentAt(a) - sentAt(b) || (a.id < b.id ? -1 : 1)).map((c) => ({ ...c, project_name: nameOf.get(c.project_id) ?? c.project_id }));
}
/** Open critical bugs on existing projects, oldest first, with `project_name`. */
export async function openCriticalBugs() {
  const bugs = await Bug.find({ status: { $in: OPEN_BUG }, severity: 'Critical' }).sort({ reported_on: 1, _id: 1 }).select('project_id title reported_on').rows();
  const projects = await Project.find({ id: { $in: [...new Set(bugs.map((b) => b.project_id))] } }).select('name').rows();
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  return bugs.filter((b) => nameOf.has(b.project_id)).map((b) => ({ ...b, project_name: nameOf.get(b.project_id) }));
}

/** Running projects by id, with the PM's name (`pm_name`, null without a PM). */
export async function runningProjects() {
  const rows = await Project.find({ status: 'Running' }).sort({ _id: 1 })
    .select('name client due_date expected_delivery_date budget_hours status_note pm_member_id').rows();
  const pm = await memberNames(rows.map((p) => p.pm_member_id));
  return rows.map(({ pm_member_id: pmId, ...p }) => ({ ...p, pm_name: pm.get(pmId) ?? null }));
}

/** Hours logged on `day` by everyone. */
export async function hoursLoggedOn(day) {
  const [r] = await TimeLog.aggregate([{ $match: { day } }, { $group: { _id: null, h: { $sum: '$hours' } } }]);
  return r ? round2(r.h) : 0;
}

export const milestonesOf = (projectIds) => Milestone.find({ project_id: { $in: projectIds } }).sort({ project_id: 1, n: 1 })
  .select('project_id n name due_date status alloc_hours approval_status approval_asked_at').rows();

/** Hours logged per project (all time) → [{ project_id, h }]. */
export async function hoursByProject(projectIds) {
  const rows = await TimeLog.aggregate([{ $match: { project_id: { $in: projectIds } } }, { $group: { _id: '$project_id', h: { $sum: '$hours' } } }]);
  return rows.map((r) => ({ project_id: r._id, h: round2(r.h) }));
}

/** Hours logged from `fromDay` ('YYYY-MM-DD', inclusive) per project and per member, with project names. */
export async function hoursSince(fromDay) {
  const match = { $match: { day: { $gte: fromDay } } };
  const [byProject, byMember] = await Promise.all([
    TimeLog.aggregate([match, { $group: { _id: '$project_id', h: { $sum: '$hours' } } }]),
    TimeLog.aggregate([match, { $group: { _id: '$member_id', h: { $sum: '$hours' } } }]),
  ]);
  const projects = await Project.find({ id: { $in: byProject.map((r) => r._id) } }).select('name').rows();
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  return {
    projects: byProject.map((r) => ({ id: r._id, name: nameOf.get(r._id) ?? r._id, h: round2(r.h) })),
    members: byMember.map((r) => ({ id: r._id, h: round2(r.h) })),
  };
}

export const shiftReportsSince = (fromDay) => ShiftReport.find({ day: { $gte: fromDay } }).select('person_id day blockers submitted_at').rows();

/** Quotes Sent / Viewed / Accepted on existing leads, with the lead's `company`. */
export async function liveQuotes() {
  const quotes = await Quote.find({ status: { $in: ['Sent', 'Viewed', 'Accepted'] } }).select('lead_id status net total sent_at viewed_at accepted_at').rows();
  const leads = await Lead.find({ id: { $in: [...new Set(quotes.map((q) => q.lead_id))] } }).select('company').rows();
  const companyOf = new Map(leads.map((l) => [l.id, l.company]));
  return quotes.filter((q) => companyOf.has(q.lead_id)).map(({ lead_id: leadId, ...q }) => ({ ...q, leadId, company: companyOf.get(leadId) }));
}

/** Projects on hold, latest status note first (no note first, as Postgres sorts NULLs), with `pm_name`. */
export async function projectsOnHold() {
  const rows = await Project.find({ status: 'On hold' }).select('name client status_reason status_note status_note_at updated_at pm_member_id').rows();
  const pm = await memberNames(rows.map((p) => p.pm_member_id));
  return rows.sort(nullsFirstDesc('status_note_at')).map(({ pm_member_id: pmId, ...p }) => ({ ...p, pm_name: pm.get(pmId) ?? null }));
}

/** Team tasks of existing users, with the assignee's name (`assignee`). */
export async function teamTasks() {
  const tasks = await TeamTask.find().select('title status priority due_date done_at assignee_id').rows();
  const users = await User.find({ id: { $in: [...new Set(tasks.map((t) => t.assignee_id))] } }).select('name').rows();
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return tasks.filter((t) => nameOf.has(t.assignee_id)).map(({ assignee_id: uid, ...t }) => ({ ...t, assignee: nameOf.get(uid) }));
}
