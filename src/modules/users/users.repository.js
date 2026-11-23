import {
  AuditLog, BugEvent, Document, LeadActivity, ProjectCredential, ProjectFollowUp, ProjectIntegration,
  RefreshToken, Role, TeamTask, TeamTaskEvent, User,
} from '../../db/models/index.js';
import { TEXT_ORDER, ilike } from '../../db/modelKit.js';

/** Columns of a user row as the API reads them (never the password / token hashes). */
const USER_FIELDS = ['_id', 'name', 'email', 'phone', 'title', 'role_id', 'dept', 'reports_to', 'join_date', 'status', 'invited_at',
  'last_active_at', 'hue', 'member_id', 'owner_id', 'client_of', 'shift_hours', 'hq_seat', 'hq_role', 'pp_user_id', 'created_at', 'updated_at'];

/** Default list order like the frontend: Active → Invited → Deactivated. */
const STATUS_RANK = { $switch: { branches: [{ case: { $eq: ['$status', 'Active'] }, then: 0 }, { case: { $eq: ['$status', 'Invited'] }, then: 1 }], default: 2 } };

/** 1 when the field is null / missing, else 0 — sorting on it first puts NULLs where Postgres does. */
const isNull = (field) => ({ $cond: [{ $eq: [{ $ifNull: [`$${field}`, null] }, null] }, 1, 0] });

/** List filters (q / role / dept / status) as a Mongo filter on `users`. */
export function filterOf(f) {
  const filter = {};
  if (f.q) filter.$or = [{ name: ilike(f.q) }, { email: ilike(f.q) }, { title: ilike(f.q) }];
  if (f.role) filter.role_id = f.role;
  if (f.dept) filter.dept = f.dept;
  if (f.status) filter.status = f.status;
  return filter;
}

export const count = (filter) => User.countDocuments(filter);

/**
 * One page of users with their role name (`role_name`), like the old users ⋈ roles query.
 * @param {object} filter      from filterOf()
 * @param {[string, 'asc'|'desc'] | null} sort  [field, direction]; null = the default status order.
 *   NULLs sort like Postgres: last when ascending, first when descending.
 * @param {{offset: number, limit: number}} paging
 */
export async function page(filter, sort, { offset, limit }) {
  const dir = sort && sort[1] === 'desc' ? -1 : 1;
  const order = sort ? { sort_null: dir, [sort[0]]: dir, _id: 1 } : { status_rank: 1, name: 1, _id: 1 };
  const docs = await User.aggregate([
    { $match: filter },
    { $lookup: { from: Role.collection.name, localField: 'role_id', foreignField: '_id', as: 'role' } },
    { $unwind: '$role' },
    {
      $project: {
        ...Object.fromEntries(USER_FIELDS.map((f) => [f, 1])),
        role_name: '$role.name',
        status_rank: STATUS_RANK,
        sort_null: sort ? isNull(sort[0]) : null,
      },
    },
    { $sort: order },
    { $skip: offset },
    { $limit: limit },
    { $project: { status_rank: 0, sort_null: 0 } },
  ]).collation(TEXT_ORDER);
  return docs.map(User.toRow);
}

export async function findById(id, session = null) {
  const u = await User.findOne({ id }).select(USER_FIELDS.join(' ')).session(session).rows();
  if (!u) return null;
  const role = await Role.findOne({ id: u.role_id }).select('name').session(session).rows();
  return role ? { ...u, role_name: role.name } : null;
}

/**
 * Delete a user and apply what the Postgres foreign keys did: refresh tokens and team tasks
 * assigned to them (with those tasks' timelines) are deleted (CASCADE); every other reference to
 * the user is cleared (SET NULL).
 */
export async function removeUser(id, session = null) {
  const opts = { session };
  const assigned = await TeamTask.distinct('_id', { assignee_id: id }).session(session);
  await TeamTaskEvent.deleteMany({ task_id: { $in: assigned } }, opts);
  await TeamTask.deleteMany({ _id: { $in: assigned } }, opts);
  await RefreshToken.deleteMany({ user_id: id }, opts);
  const setNull = [
    [User, 'reports_to'], [AuditLog, 'actor_user_id'], [LeadActivity, 'actor_user_id'], [BugEvent, 'actor_user_id'],
    [Document, 'uploaded_by'], [ProjectFollowUp, 'created_by'], [ProjectIntegration, 'created_by'],
    [ProjectCredential, 'updated_by'], [TeamTask, 'created_by'], [TeamTaskEvent, 'user_id'],
  ];
  for (const [Model, field] of setNull) await Model.updateMany({ [field]: id }, { [field]: null }, opts);
  await User.deleteOne({ id }, opts);
}
