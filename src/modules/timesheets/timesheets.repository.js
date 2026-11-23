/**
 * MongoDB queries for time logs. Lists are aggregation pipelines: the log match, then the member and
 * project (inner joins) and the milestone (left join) looked up — the rows the old SQL joins returned.
 */
import { Project, ProjectMember, TimeLog } from '../../db/models/index.js';
import { TEXT_ORDER } from '../../db/modelKit.js';
import { dayInRange } from './period.js';

/** Sortable keys (?sort=) → field of the joined pipeline. */
export const LOG_SORTS = { date: 'day', hours: 'hours', member: 'mb.name', project: 'p.name', created: 'created_at' };

/** NUMERIC(…, 2) sums: round away binary floating-point noise. */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** `$lookup` of one referenced row, keeping only `fields`; `required` drops logs without it (inner join). */
const joinOne = (from, localField, as, fields, { required = false } = {}) => [
  { $lookup: { from, localField, foreignField: '_id', as, pipeline: [{ $project: fields }] } },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: !required } },
];

/**
 * Logs within scope { projectIds, people } (null = unrestricted) + filters (member / project / team /
 * milestone / id) + optional day range, with member, project and milestone joined in.
 */
export function base(scope, f, rg = null) {
  const and = [];
  if (scope.projectIds) and.push({ project_id: { $in: scope.projectIds } });
  if (scope.people) and.push({ member_id: { $in: scope.people } });
  if (f.ids) and.push({ _id: { $in: f.ids } });
  if (f.member) and.push({ member_id: f.member });
  if (f.project) and.push({ project_id: f.project });
  if (f.milestone) and.push({ milestone_id: f.milestone });
  const days = dayInRange(rg);
  if (days) and.push({ day: days });
  return [
    ...(and.length ? [{ $match: { $and: and } }] : []),
    ...joinOne('members', 'member_id', 'mb', { name: 1, team: 1, hue: 1 }, { required: true }),
    ...joinOne('projects', 'project_id', 'p', { name: 1, hue: 1 }, { required: true }),
    ...joinOne('milestones', 'milestone_id', 'm', { name: 1 }),
    ...(f.team ? [{ $match: { 'mb.team': f.team } }] : []),
  ];
}

/** Aggregate result → the row shape of the old `l.*, mb.name as member_name …` select. */
const toJoinedRow = ({ mb, p, m, ...l }) => ({
  ...TimeLog.toRow(l),
  member_name: mb.name,
  member_team: mb.team,
  project_name: p.name,
  project_hue: p.hue,
  milestone_name: m ? m.name : null,
});

/** Optional explicit sort first, then newest day, member name, id. */
function sortStage(sort) {
  const order = sort ? { [sort[0]]: sort[1] === 'desc' ? -1 : 1 } : {};
  for (const [field, dir] of [['day', -1], ['mb.name', 1], ['_id', 1]]) if (!(field in order)) order[field] = dir;
  return { $sort: order };
}

export async function list(scope, f, rg, sort, page) {
  const [res] = await TimeLog.aggregate([
    ...base(scope, f, rg),
    {
      $facet: {
        rows: [sortStage(sort), { $skip: page.offset }, { $limit: page.limit }],
        totals: [{ $group: { _id: null, count: { $sum: 1 }, hours: { $sum: '$hours' } } }],
      },
    },
  ]).collation(TEXT_ORDER);
  const totals = res.totals[0] || { count: 0, hours: 0 };
  return { rows: res.rows.map(toJoinedRow), total: totals.count, hours: r2(totals.hours) };
}

/** Every matching entry (CSV export), newest first. */
export async function all(scope, f, rg) {
  const rows = await TimeLog.aggregate([...base(scope, f, rg), sortStage(null)]).collation(TEXT_ORDER);
  return rows.map(toJoinedRow);
}

/** Aggregation expression: `$day` within [from, toExclusive) — true when unbounded. */
function dayWithin(rg) {
  const and = [];
  if (rg && rg[0]) and.push({ $gte: ['$day', rg[0]] });
  if (rg && rg[1]) and.push({ $lt: ['$day', rg[1]] });
  return and.length ? { $and: and } : true;
}

/** `$group` accumulators: hours today / yesterday / this week / this month / in range / all time. */
function hourBuckets(d) {
  const sumIf = (cond) => ({ $sum: { $cond: [cond, '$hours', 0] } });
  return {
    today: sumIf({ $eq: ['$day', d.today] }),
    yesterday: sumIf({ $eq: ['$day', d.yesterday] }),
    week: sumIf(dayWithin(d.week)),
    month: sumIf(dayWithin(d.month)),
    range: sumIf(dayWithin(d.range)),
    all: { $sum: '$hours' },
  };
}

const HOUR_KEYS = ['today', 'yesterday', 'week', 'month', 'range', 'all'];

/** Hours today / yesterday / this week / this month / in range / all time, + entry count in range. */
export async function summary(scope, f, d) {
  const [r] = await TimeLog.aggregate([
    ...base(scope, f),
    { $group: { _id: null, ...hourBuckets(d), entries: { $sum: { $cond: [dayWithin(d.range), 1, 0] } } } },
  ]);
  return { ...Object.fromEntries(HOUR_KEYS.map((k) => [k, r2(r?.[k])])), entries: r ? r.entries : 0 };
}

/** Member × project hours in the range, ordered by member name then project name. */
export async function matrix(scope, f, rg) {
  const cells = await TimeLog.aggregate([
    ...base(scope, f, rg),
    {
      $group: {
        _id: { member_id: '$member_id', project_id: '$project_id' },
        member_name: { $first: '$mb.name' },
        member_team: { $first: '$mb.team' },
        member_hue: { $first: '$mb.hue' },
        project_name: { $first: '$p.name' },
        project_hue: { $first: '$p.hue' },
        hours: { $sum: '$hours' },
      },
    },
    { $sort: { member_name: 1, project_name: 1 } },
  ]).collation(TEXT_ORDER);
  return cells.map(({ _id, hours, ...c }) => ({ ..._id, ...c, hours: r2(hours) }));
}

/** Existing hours of a member on a day (for the 24h rule). */
export async function dayTotal(memberId, day, session = null) {
  const [r] = await TimeLog.aggregate([{ $match: { member_id: memberId, day } }, { $group: { _id: null, h: { $sum: '$hours' } } }]).session(session);
  return r2(r?.h);
}

/** One log within scope (with joins), or null. */
export async function getById(scope, id, session = null) {
  const [row] = await TimeLog.aggregate([...base(scope, { ids: [id] }), { $limit: 1 }]).session(session);
  return row ? toJoinedRow(row) : null;
}

/** Logs by id (with joins), in id order. */
export async function findByIds(ids, session = null) {
  const rows = await TimeLog.aggregate([...base({}, { ids }), { $sort: { _id: 1 } }]).collation(TEXT_ORDER).session(session);
  return rows.map(toJoinedRow);
}

export const insert = (rows, session = null) => TimeLog.insertMany(rows, { session });
export const remove = (id, session = null) => TimeLog.deleteOne({ id }, { session });
export const removeMany = (ids, session = null) => TimeLog.deleteMany({ id: { $in: ids } }, { session });

/* ── Team & hours ── */

/**
 * Per-member hour aggregates over logs of the given projects (null = unrestricted) for the given members.
 * @returns {Promise<Array<{member_id: string, today: number, yesterday: number, week: number, month: number, range: number, all: number}>>}
 */
export async function memberHours(memberIds, projectIds, d) {
  if (!memberIds.length) return [];
  const match = { member_id: { $in: memberIds }, ...(projectIds ? { project_id: { $in: projectIds } } : {}) };
  const rows = await TimeLog.aggregate([{ $match: match }, { $group: { _id: '$member_id', ...hourBuckets(d) } }]);
  return rows.map(({ _id, ...h }) => ({ member_id: _id, ...Object.fromEntries(HOUR_KEYS.map((k) => [k, r2(h[k])])) }));
}

const ACTIVE_STATUSES = ['Running', 'On hold', 'Planning'];

/**
 * Allocation vs taken per member on their active projects (Running / On hold / Planning),
 * restricted to `projectIds` (null = all): allocated hours, hours taken (all time), project count, running?
 */
export async function allocation(memberIds, projectIds) {
  if (!memberIds.length) return [];
  const seats = await ProjectMember.find({ member_id: { $in: memberIds }, ...(projectIds ? { project_id: { $in: projectIds } } : {}) })
    .select('project_id member_id alloc_hours').rows();
  if (!seats.length) return [];
  const pids = [...new Set(seats.map((s) => s.project_id))];
  const [projects, logged] = await Promise.all([
    Project.find({ id: { $in: pids } }).select('status').rows(),
    TimeLog.aggregate([
      { $match: { member_id: { $in: memberIds }, project_id: { $in: pids } } },
      { $group: { _id: { member_id: '$member_id', project_id: '$project_id' }, hours: { $sum: '$hours' } } },
    ]),
  ]);
  const statusOf = new Map(projects.map((p) => [p.id, p.status]));
  const takenOf = new Map(logged.map((l) => [`${l._id.member_id}|${l._id.project_id}`, l.hours]));
  const out = new Map();
  for (const s of seats) {
    const status = statusOf.get(s.project_id);
    if (!status) continue; // seat on a project that no longer exists (the SQL inner join dropped it)
    const a = out.get(s.member_id) || { member_id: s.member_id, allocated: 0, taken: 0, projects: 0, running: false };
    if (ACTIVE_STATUSES.includes(status)) {
      a.allocated += Number(s.alloc_hours) || 0;
      a.taken += takenOf.get(`${s.member_id}|${s.project_id}`) || 0;
      a.projects += 1;
    }
    a.running ||= status === 'Running';
    out.set(s.member_id, a);
  }
  return [...out.values()].map((a) => ({ ...a, allocated: r2(a.allocated), taken: r2(a.taken) }));
}
