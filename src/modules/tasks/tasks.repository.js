/**
 * MongoDB queries for project tasks. Lists are aggregation pipelines: the task match, then the
 * project (inner join), milestone and assignee (left joins) looked up, then the conditions on
 * joined fields — the same rows the old SQL joins returned.
 */
import { ActiveTimer, Member, Milestone, Project, Task } from '../../db/models/index.js';
import { ilike, TEXT_ORDER } from '../../db/modelKit.js';

/** Current milestone of a project: first not-Done by n, else the last; null if none (frontend curMs). */
export async function curMs(projectId, session = null) {
  const ms = await Milestone.find({ project_id: projectId }).sort({ n: 1 }).select('status').session(session).rows();
  return ((ms.find((m) => m.status !== 'Done') || ms[ms.length - 1]) || {}).id || null;
}

export const findMilestone = (id, session = null) => Milestone.findOne({ id }).select('project_id').session(session).rows();
export const findMember = (id, session = null) => Member.findOne({ id }).select('name team').session(session).rows();
export const findProject = (id, session = null) => Project.findOne({ id }).select('name').session(session).rows();

/** Sortable keys (?sort=) → computed / stored field of the pipeline. */
export const TASK_SORTS = {
  due: 'due_date', priority: 'prio_rank', status: 'status_rank', created: 'created_at', updated: 'updated_at', title: 'title', id: '_id',
};

/** The two rank fields the list orders by (frontend taskSort): priority High→Low, status To do→Done. */
const RANKS = {
  prio_rank: { $indexOfArray: [['High', 'Medium', 'Low'], '$priority'] },
  status_rank: { $indexOfArray: [['To do', 'In progress', 'Blocked', 'In review', 'Done'], '$status'] },
};

/** `$lookup` of one referenced row (a left join), keeping only `fields`. */
const joinOne = (from, localField, as, fields, { required = false } = {}) => [
  { $lookup: { from, localField, foreignField: '_id', as, pipeline: [{ $project: fields }] } },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: !required } },
];

/** True in an aggregation expression when `field` holds a day string (NULL never compares, like SQL). */
const hasDay = (field) => ({ $eq: [{ $type: field }, 'string'] });

/**
 * Conditions on the task document itself: row scope ({ projectIds, people } — null = unrestricted),
 * list filters and the quick chip (chips use today / end of this week).
 */
function taskConditions(scope, f, { today, weekEnd }) {
  const and = [];
  if (scope.projectIds) and.push({ project_id: { $in: scope.projectIds } });
  if (scope.people) and.push({ assignee_id: { $in: scope.people } });
  if (f.id) and.push({ _id: f.id });
  if (f.project) and.push({ project_id: f.project });
  if (f.milestone) and.push({ milestone_id: f.milestone });
  if (f.assignee) and.push({ assignee_id: f.assignee });
  if (f.status) and.push({ status: f.status });
  if (f.priority) and.push({ priority: f.priority });
  const open = { status: { $ne: 'Done' } };
  switch (f.chip) {
    case 'overdue': and.push(open, { due_date: { $lt: today } }); break;
    case 'week': and.push(open, { due_date: { $gte: today, $lt: weekEnd } }); break;
    case 'high': and.push(open, { priority: 'High' }); break;
    case 'blocked': and.push({ status: 'Blocked' }); break;
    case 'unassigned': and.push({ assignee_id: null }); break;
    default: break;
  }
  return and;
}

/** Conditions on the joined project / assignee. */
function joinedConditions(f) {
  const and = [];
  if (f.team) and.push({ 'a.team': f.team });
  if (f.q) {
    const like = ilike(f.q);
    and.push({ $or: [{ title: like }, { 'p.name': like }, { 'a.name': like }, { _id: like }] });
  }
  return and;
}

const matchAll = (and) => (and.length ? [{ $match: { $and: and } }] : []);

/** Scoped + filtered tasks with their project, milestone and assignee joined in. */
function pipeline(scope, f, ctx) {
  return [
    ...matchAll(taskConditions(scope, f, ctx)),
    ...joinOne('projects', 'project_id', 'p', { name: 1 }, { required: true }),
    ...joinOne('milestones', 'milestone_id', 'm', { name: 1, n: 1 }),
    ...joinOne('members', 'assignee_id', 'a', { name: 1, team: 1 }),
    ...matchAll(joinedConditions(f)),
  ];
}

/** Aggregate result → the row shape of the old `t.*, p.name as project_name …` select. */
function toJoinedRow({ p, m, a, prio_rank: _p, status_rank: _s, nulls_last: _n, ...t }) {
  return {
    ...Task.toRow(t),
    project_name: p.name,
    milestone_name: m ? m.name : null,
    milestone_n: m ? m.n : null,
    assignee_name: a ? a.name : null,
    assignee_team: a ? a.team : null,
  };
}

const NO_CHIP_CTX = { today: '', weekEnd: '' };

/** One task within scope (with joins), or null. */
export async function getById(scope, id, session = null) {
  const [row] = await Task.aggregate([...pipeline(scope, { id }, NO_CHIP_CTX), { $limit: 1 }]).session(session);
  return row ? toJoinedRow(row) : null;
}

/**
 * Sort stages. An explicit sort is `[field, 'asc'|'desc']` with NULLs last either way, then id;
 * the default is the frontend list order: status, priority, due date (NULLs last), id.
 */
function sortStages(sort) {
  const nullsLast = (field) => ({ $cond: [{ $eq: [{ $ifNull: [`$${field}`, null] }, null] }, 1, 0] });
  if (sort) {
    const [field, dir] = sort;
    return [{ $addFields: { ...RANKS, nulls_last: nullsLast(field) } }, { $sort: { nulls_last: 1, [field]: dir === 'desc' ? -1 : 1, _id: 1 } }];
  }
  return [{ $addFields: { ...RANKS, nulls_last: nullsLast('due_date') } }, { $sort: { status_rank: 1, prio_rank: 1, nulls_last: 1, due_date: 1, _id: 1 } }];
}

/** One page of tasks + the total over the same filters. */
export async function list(scope, f, ctx, sort, page) {
  const [res] = await Task.aggregate([
    ...pipeline(scope, f, ctx),
    { $facet: { rows: [...sortStages(sort), { $skip: page.offset }, { $limit: page.limit }], total: [{ $count: 'n' }] } },
  ]).collation(TEXT_ORDER);
  return { rows: res.rows.map(toJoinedRow), total: res.total.length ? res.total[0].n : 0 };
}

/** Counts for the chips + summary line, over the same filters (no chip). */
export async function counts(scope, f, { today, weekEnd }) {
  const open = { $ne: ['$status', 'Done'] };
  const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const [r] = await Task.aggregate([
    ...pipeline(scope, { ...f, chip: undefined }, { today, weekEnd }),
    {
      $group: {
        _id: null,
        all: { $sum: 1 },
        open: count(open),
        done: count({ $eq: ['$status', 'Done'] }),
        overdue: count({ $and: [open, hasDay('$due_date'), { $lt: ['$due_date', today] }] }),
        week: count({ $and: [open, hasDay('$due_date'), { $gte: ['$due_date', today] }, { $lt: ['$due_date', weekEnd] }] }),
        high: count({ $and: [open, { $eq: ['$priority', 'High'] }] }),
        blocked: count({ $eq: ['$status', 'Blocked'] }),
        unassigned: count({ $eq: [{ $ifNull: ['$assignee_id', null] }, null] }),
      },
    },
  ]);
  if (!r) return { all: 0, open: 0, done: 0, overdue: 0, week: 0, high: 0, blocked: 0, unassigned: 0 };
  const { all, open: openCount, done, overdue, week, high, blocked, unassigned } = r;
  return { all, open: openCount, done, overdue, week, high, blocked, unassigned };
}

export const insert = (row, session = null) => Task.insertMany([row], { session });

/** `$set` the patch and optionally `$push` one log line. */
export function update(id, patch, logLine = null, session = null) {
  const change = { ...(Object.keys(patch).length ? { $set: patch } : {}), ...(logLine ? { $push: { log: logLine } } : {}) };
  return Task.updateOne({ id }, change, { session });
}

/** Delete a task and its running timers (former FK active_timers.task_id ON DELETE CASCADE). */
export async function remove(id, session = null) {
  await ActiveTimer.deleteMany({ task_id: id }, { session });
  await Task.deleteOne({ id }, { session });
}
