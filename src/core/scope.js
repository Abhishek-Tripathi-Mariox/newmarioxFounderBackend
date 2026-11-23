import { Member, Project, ProjectMember } from '../db/models/index.js';
import { scopeOf } from '../middleware/authorize.js';

/**
 * Who the current user may see for a module, mirroring the frontend's scopeState():
 *  - 'all'  → everyone
 *  - 'team' → people in the same delivery team as the user (plus the user)
 *  - 'own'  → only the user's own person id (member id / sales-owner id)
 * Returns { scope, pid, people: string[] | null } — `people` is null when unrestricted.
 */
export async function peopleScope(user, mod) {
  const scope = scopeOf(user, mod);
  if (scope === 'all') return { scope, pid: user.pid, people: null };
  if (scope === 'own' || !user.team) return { scope, pid: user.pid, people: [user.pid] };
  const teammates = await Member.distinct('_id', { team: user.team });
  return { scope, pid: user.pid, people: Array.from(new Set([user.pid, ...teammates])) };
}

/**
 * Project ids the user may see (frontend rules): clients → their projects only; scope 'own' →
 * projects they manage or are on; 'team' → projects whose PM or a team member is in their team.
 * Returns null when unrestricted.
 */
export async function visibleProjectIds(user) {
  if (user.isSuper) return null;
  if (user.role.id === 'r-client') return user.clientOf || [];
  const { scope, people } = await peopleScope(user, 'projects');
  if (scope === 'all') return null;
  const [managed, staffed] = await Promise.all([
    Project.distinct('_id', { pm_member_id: { $in: people } }),
    ProjectMember.distinct('project_id', { member_id: { $in: people } }),
  ]);
  return Array.from(new Set([...managed, ...staffed]));
}

/**
 * Add an optional id allow-list to a Mongo filter: `restrictTo({ status: 'Open' }, 'project_id', ids)`.
 * `ids` null = unrestricted; an empty list matches nothing.
 */
export function restrictTo(filter, field, ids) {
  if (!ids) return filter;
  const allowed = { [field]: { $in: ids } };
  return field in filter ? { $and: [filter, allowed] } : { ...filter, ...allowed };
}
