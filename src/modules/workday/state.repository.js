/**
 * MongoDB reads behind state.service (raw workday data). `events` and `presenceMap` are shared with
 * workday.service / live.service / founder; their other queries live in workday.repository.js.
 */
import { ActiveTimer, ActivityFeed, AttendanceEvent, Lead, LeadActivity, Presence, ShiftReport } from '../../db/models/index.js';

/** `{ field: { $in: pids } }`, or no condition when `pids` is null (everyone). */
const onlyPeople = (field, pids) => (pids ? { [field]: { $in: pids } } : {});
const between = (from, to) => ({ $gte: new Date(from), $lt: new Date(to) });

const toEvent = (r) => ({ id: r.id, t: new Date(r.at).getTime(), k: r.kind, who: r.person_id, meta: r.meta || {} });

/** Attendance events for people (null = everyone) in [from, to), oldest first. */
export async function events(pids, from, to, session = null) {
  const rows = await AttendanceEvent.find({ at: between(from, to), ...onlyPeople('person_id', pids) })
    .sort({ at: 1, _id: 1 }).session(session).rows();
  return rows.map(toEvent);
}

/** Every running timer. */
export const timers = (session = null) => ActiveTimer.find().session(session).rows();

/** Last activity per person → { pid: ms }. */
export async function presenceMap(session = null) {
  const rows = await Presence.find().session(session).rows();
  return Object.fromEntries(rows.map((r) => [r.person_id, new Date(r.last_activity_at).getTime()]));
}

/** Live-feed lines in [from, to) for people (null = everyone), oldest first. */
export const feedBetween = (pids, from, to) => ActivityFeed.find({ at: between(from, to), ...onlyPeople('person_id', pids) })
  .sort({ at: 1, _id: 1 }).select('person_id kind text lead_id at').rows();

/**
 * Lead activities in [from, to) on leads owned by `pids` (null = everyone), oldest first, each with
 * its lead's `owner_id`.
 */
export async function leadActivitiesBetween(pids, from, to) {
  const acts = await LeadActivity.find({ at: between(from, to) }).sort({ at: 1, _id: 1 }).select('at kind text lead_id').rows();
  if (!acts.length) return [];
  const leads = await Lead.find({ id: { $in: [...new Set(acts.map((a) => a.lead_id))] }, ...onlyPeople('owner_id', pids) }).select('owner_id').rows();
  const ownerOf = new Map(leads.map((l) => [l.id, l.owner_id]));
  return acts.filter((a) => ownerOf.has(a.lead_id)).map((a) => ({ ...a, owner_id: ownerOf.get(a.lead_id) }));
}

/** End-of-shift reports for people (null = everyone), optional inclusive 'YYYY-MM-DD' bounds, oldest day first. */
export function shiftReports(pids, { from, to } = {}) {
  const filter = onlyPeople('person_id', pids);
  if (from || to) filter.day = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return ShiftReport.find(filter).sort({ day: 1, submitted_at: 1, _id: 1 }).rows();
}
