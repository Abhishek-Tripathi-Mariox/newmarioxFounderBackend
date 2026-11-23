import { PpProject, PpUser } from '../../../db/models/index.js';
import { DEFAULT_COMMISSION_RATE } from '../lib/constants.js';
import { PpError } from '../lib/http.js';
import { eq, runList } from '../lib/list.js';
import { scope } from '../lib/session.js';

/**
 * Partner projects and their client payment schedule (mariox-saas src/app/api/projects/**). Admins
 * create and edit; partners read their own. A payout is released by marking the payment `received`
 * and filling `releasedAt` (+ UTR); see lib/metrics.js for the commission states.
 */
const LIST = {
  search: ['client', 'title', 'pm', 'contact', 'city'],
  sorts: ['closedAt', 'deal', 'client', 'updatedAt'],
  defaultSort: '-closedAt',
  filters: { stage: eq('stage', Number), owner: eq('owner') },
};

export async function list(s, req) {
  const { items, meta } = await runList(PpProject, scope(s), req, LIST, { path: 'owner', select: 'name company partnerCode commissionRate' });
  return { projects: items, meta };
}

export async function get(s, id) {
  const project = await PpProject.findOne({ _id: id, ...scope(s) }).lean();
  if (!project) throw new PpError(404, 'Project not found');
  return project;
}

/** Locks the commission rate to the partner's current rate unless one is given. */
export async function create(data) {
  if (data.commissionRate == null) {
    const partner = await PpUser.findById(data.owner).select('commissionRate').lean();
    data.commissionRate = partner?.commissionRate ?? DEFAULT_COMMISSION_RATE;
  }
  return PpProject.create(data);
}

export async function update(id, data) {
  const project = await PpProject.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!project) throw new PpError(404, 'Project not found');
  return project;
}

export const remove = (id) => PpProject.findByIdAndDelete(id);
