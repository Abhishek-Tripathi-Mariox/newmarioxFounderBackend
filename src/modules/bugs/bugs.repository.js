/**
 * MongoDB queries for bugs and their history. Lists are aggregation pipelines: the bug match, then
 * the project (inner join), milestone, assignee and reporter (left joins) looked up, then the
 * conditions on joined fields — the rows the old SQL joins returned.
 */
import { Bug, BugEvent, Document, Member, ProjectMember, User } from '../../db/models/index.js';
import { ilike, TEXT_ORDER } from '../../db/modelKit.js';
import { config } from '../../config/index.js';
import { dayInRange, daysBetween } from '../timesheets/period.js';

/** Sortable keys (?sort=) → computed / stored field of the pipeline. */
export const BUG_SORTS = {
  due: 'due_date', severity: 'sev_rank', status: 'status_rank', reported: 'reported_on', created: 'created_at', updated: 'updated_at', id: '_id', title: 'title',
};
const RANKS = {
  sev_rank: { $indexOfArray: [['Critical', 'Major', 'Minor', 'Trivial'], '$severity'] },
  status_rank: { $indexOfArray: [['Open', 'In progress', 'Fixed', 'Retest', 'Reopened', 'Closed'], '$status'] },
};
/** Server timezone (APP_TZ), so event timestamps become the same local calendar days as `today`. */
const TZ = config.timeZone;
/** "Open" bugs: anything not Closed / Fixed. */
const OPEN_STATUSES = { $nin: ['Closed', 'Fixed'] };
const isOpenExpr = { $not: [{ $in: ['$status', ['Closed', 'Fixed']] }] };

/** `$lookup` of one referenced row, keeping only `fields`; `required` drops bugs without it (inner join). */
const joinOne = (from, localField, as, fields, { required = false } = {}) => [
  { $lookup: { from, localField, foreignField: '_id', as, pipeline: [{ $project: fields }] } },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: !required } },
];

/**
 * Conditions on the bug document: row scope { projectIds, people, pid } (null = unrestricted; with a
 * people list a bug is visible when assigned to one of them or reported by the user), the filters that
 * define the KPI "set", the reported-on range and the quick filter.
 */
function bugConditions(scope, f, rg, quick, today) {
  const and = [];
  if (scope.projectIds) and.push({ project_id: { $in: scope.projectIds } });
  if (scope.people) and.push({ $or: [{ assignee_id: { $in: scope.people } }, { reporter: scope.pid || '__none__' }] });
  if (f.id) and.push({ _id: f.id });
  if (f.project) and.push({ project_id: f.project });
  if (f.member) and.push({ assignee_id: f.member });
  if (f.team) and.push({ dept: f.team });
  if (f.dept) and.push({ dept: f.dept });
  if (f.sev) and.push({ severity: f.sev });
  if (f.env) and.push({ env: f.env });
  if (f.reporter) and.push({ reporter: f.reporter });
  if (f.status) and.push({ status: f.status });
  const days = dayInRange(rg);
  if (days) and.push({ reported_on: days });
  switch (quick) {
    case 'open': and.push({ status: OPEN_STATUSES }); break;
    case 'overdue': and.push({ status: OPEN_STATUSES }, { due_date: { $lt: today } }); break;
    case 'critical': and.push({ status: OPEN_STATUSES }, { severity: 'Critical' }); break;
    case 'reopened': and.push({ status: 'Reopened' }); break;
    case 'unassigned': and.push({ assignee_id: null }); break;
    case 'closed': and.push({ status: 'Closed' }); break;
    default: break;
  }
  return and;
}

/** Conditions on the joined project / assignee. */
function joinedConditions(f) {
  const and = [];
  if (f.projectStatus) and.push({ 'p.status': f.projectStatus });
  if (f.q) {
    const like = ilike(f.q);
    and.push({ $or: [{ _id: like }, { title: like }, { 'p.name': like }, { 'a.name': like }] });
  }
  return and;
}

const matchAll = (and) => (and.length ? [{ $match: { $and: and } }] : []);

/** Scoped + filtered bugs with project, milestone, assignee and reporter joined in. */
function pipeline(scope, f, { rg = null, quick = null, today = '' } = {}) {
  return [
    ...matchAll(bugConditions(scope, f, rg, quick, today)),
    ...joinOne('projects', 'project_id', 'p', { name: 1, status: 1 }, { required: true }),
    ...joinOne('milestones', 'milestone_id', 'm', { name: 1 }),
    ...joinOne('members', 'assignee_id', 'a', { name: 1 }),
    ...joinOne('members', 'reporter', 'r', { name: 1 }),
    ...matchAll(joinedConditions(f)),
  ];
}

/** Number of documents attached to each bug (run after paging). */
const ATTACHMENT_COUNT = [
  { $lookup: { from: 'documents', localField: '_id', foreignField: 'entity_id', as: 'docs', pipeline: [{ $match: { entity_type: 'bug' } }, { $project: { _id: 1 } }] } },
  { $addFields: { attachment_count: { $size: '$docs' } } },
];

/** Aggregate result → the row shape of the old `b.*, p.name as project_name …` select. */
function toJoinedRow({ p, m, a, r, docs: _d, sev_rank: _s, status_rank: _st, nulls_last: _n, ...b }) {
  return {
    ...Bug.toRow(b),
    project_name: p.name,
    milestone_name: m ? m.name : null,
    assignee_name: a ? a.name : null,
    reporter_name: r ? r.name : null,
  };
}

/** One bug within scope (with joins and attachment count), or null. */
export async function getById(scope, id, session = null) {
  const [row] = await Bug.aggregate([...pipeline(scope, { id }), { $limit: 1 }, ...ATTACHMENT_COUNT]).session(session);
  return row ? toJoinedRow(row) : null;
}

/**
 * Sort stages. An explicit sort is `[field, 'asc'|'desc']` with NULLs last either way, then id;
 * the default is bugSort: most severe first, then earliest due date (NULLs last), then id.
 */
function sortStages(sort) {
  const nullsLast = (field) => ({ $cond: [{ $eq: [{ $ifNull: [`$${field}`, null] }, null] }, 1, 0] });
  if (sort) {
    const [field, dir] = sort;
    return [{ $addFields: { ...RANKS, nulls_last: nullsLast(field) } }, { $sort: { nulls_last: 1, [field]: dir === 'desc' ? -1 : 1, _id: 1 } }];
  }
  return [{ $addFields: { ...RANKS, nulls_last: nullsLast('due_date') } }, { $sort: { sev_rank: 1, nulls_last: 1, due_date: 1, _id: 1 } }];
}

/** One page of bugs + the total over the same filters and quick filter. */
export async function list(scope, f, rg, today, sort, page) {
  const [res] = await Bug.aggregate([
    ...pipeline(scope, f, { rg, quick: f.quick, today }),
    { $facet: { rows: [...sortStages(sort), { $skip: page.offset }, { $limit: page.limit }, ...ATTACHMENT_COUNT], total: [{ $count: 'n' }] } },
  ]).collation(TEXT_ORDER);
  return { rows: res.rows.map(toJoinedRow), total: res.total.length ? res.total[0].n : 0 };
}

/**
 * Average days from report to close over closed bugs; the closed date is the local (APP_TZ) day of
 * the bug's last history entry (today when it has none), like bugClosedAt().
 */
async function avgDaysToClose(closed, today) {
  if (!closed.length) return null;
  const last = await BugEvent.aggregate([
    { $match: { bug_id: { $in: closed.map((b) => b._id) } } },
    { $group: { _id: '$bug_id', at: { $max: '$at' } } },
    { $project: { day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: TZ } } } },
  ]);
  const closedOn = new Map(last.map((e) => [e._id, e.day]));
  const total = closed.reduce((x, b) => x + Math.max(0, daysBetween(b.reported_on, closedOn.get(b._id) || today)), 0);
  return total / closed.length;
}

/**
 * KPI block over the filtered set (BugsTab): open, critical, overdue, reopened, unassigned, closed,
 * total, avgDaysToClose.
 */
export async function kpis(scope, f, rg, today) {
  const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const overdue = { $and: [isOpenExpr, { $eq: [{ $type: '$due_date' }, 'string'] }, { $lt: ['$due_date', today] }] };
  const [res] = await Bug.aggregate([
    ...pipeline(scope, f, { rg }),
    {
      $facet: {
        counts: [{
          $group: {
            _id: null,
            total: { $sum: 1 },
            open: count(isOpenExpr),
            critical: count({ $and: [isOpenExpr, { $eq: ['$severity', 'Critical'] }] }),
            overdue: count(overdue),
            reopened: count({ $eq: ['$status', 'Reopened'] }),
            unassigned: count({ $eq: [{ $ifNull: ['$assignee_id', null] }, null] }),
            closed: count({ $eq: ['$status', 'Closed'] }),
          },
        }],
        closed: [{ $match: { status: 'Closed' } }, { $project: { reported_on: 1 } }],
      },
    },
  ]);
  const c = res.counts[0] || { total: 0, open: 0, critical: 0, overdue: 0, reopened: 0, unassigned: 0, closed: 0 };
  const avg = await avgDaysToClose(res.closed, today);
  return {
    total: c.total, open: c.open, critical: c.critical, overdue: c.overdue, reopened: c.reopened, unassigned: c.unassigned, closed: c.closed,
    avgDaysToClose: avg == null ? 0 : Math.round(avg * 10) / 10,
  };
}

/** History rows (oldest first) with the actor's name, like the old `left join users`. */
async function withActorNames(rows, session) {
  const actorIds = [...new Set(rows.map((e) => e.actor_user_id).filter(Boolean))];
  const users = actorIds.length ? await User.find({ id: { $in: actorIds } }).select('name').session(session).rows() : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((e) => ({ ...e, actor_name: nameOf.get(e.actor_user_id) ?? null }));
}

export async function events(id, session = null) {
  return withActorNames(await BugEvent.find({ bug_id: id }).sort({ at: 1, _id: 1 }).session(session).rows(), session);
}

/** Events of many bugs (list ?include=events). */
export async function eventsOfMany(ids, session = null) {
  return withActorNames(await BugEvent.find({ bug_id: { $in: ids } }).sort({ at: 1, _id: 1 }).session(session).rows(), session);
}

export const attachments = (id, session = null) => Document.find({ entity_type: 'bug', entity_id: id }).sort({ created_at: 1 }).session(session).rows();

/** Remove some of a bug's attachment rows; returns their storage keys (delete the files after commit). */
export async function removeAttachments(bugId, documentIds, session = null) {
  const filter = { entity_type: 'bug', entity_id: bugId, id: { $in: documentIds } };
  const gone = await Document.find(filter).select('storage_path').session(session).rows();
  if (gone.length) await Document.deleteMany({ id: { $in: gone.map((d) => d.id) } }, { session });
  return gone.map((d) => d.storage_path);
}

export const addEvents = (bugId, texts, actorId, session = null) => (texts.length
  ? BugEvent.insertMany(texts.map((text) => ({ bug_id: bugId, text, actor_user_id: actorId })), { session })
  : Promise.resolve());

/** First project member (team order) from a department — the frontend's dept auto-assign. */
export async function firstOfTeam(projectId, team, session = null) {
  const seats = await ProjectMember.find({ project_id: projectId }).sort({ position: 1, member_id: 1 }).select('member_id').session(session).rows();
  if (!seats.length) return null;
  const inTeam = new Set(await Member.distinct('_id', { _id: { $in: seats.map((s) => s.member_id) }, team }).session(session));
  const seat = seats.find((s) => inTeam.has(s.member_id));
  return seat ? { id: seat.member_id } : null;
}

/** User who reported the bug (actor of its first history entry). */
export const firstActor = (id, session = null) => BugEvent.findOne({ bug_id: id }).sort({ _id: 1 }).select('actor_user_id').session(session).rows();

export const insert = (row, session = null) => Bug.insertMany([row], { session });
export const update = (id, patch, session = null) => Bug.updateOne({ id }, { $set: patch }, { session });

/** Delete a bug and its history (former FK bug_events.bug_id ON DELETE CASCADE). */
export async function remove(id, session = null) {
  await BugEvent.deleteMany({ bug_id: id }, { session });
  await Bug.deleteOne({ id }, { session });
}
