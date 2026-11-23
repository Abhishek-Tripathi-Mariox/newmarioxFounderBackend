/**
 * Follow-ups — port of frontend saveFu / toggleFu / delFu / checkReminders and the follow-up
 * page filters (features/followups/model.js). Scope comes from the `fu` permission.
 */
import { tx } from '../../db/mongo.js';
import { ilike, TEXT_ORDER } from '../../db/modelKit.js';
import { FollowUp, Lead, SalesOwner, Setting } from '../../db/models/index.js';
import { nextId } from '../../core/ids.js';
import { peopleScope, restrictTo } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams, sortParam } from '../../core/http.js';
import { DAY, MINUTE, parseDay, sod } from '../leads/leads.util.js';
import { toFollowUp } from './followups.mapper.js';
import { FU_DEFAULTS } from './followups.schemas.js';

const people = async (user) => (await peopleScope(user, 'fu')).people;

/**
 * Add each follow-up's lead `lead_company` / `lead_contact` (null without a lead), like the old
 * `left join leads`.
 */
export async function withLeadNames(rows, session = null) {
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const leads = leadIds.length ? await Lead.find({ id: { $in: leadIds } }).select('company contact').session(session).rows() : [];
  const byId = new Map(leads.map((l) => [l.id, l]));
  return rows.map((r) => {
    const lead = byId.get(r.lead_id);
    return { ...r, lead_company: lead ? lead.company : null, lead_contact: lead ? lead.contact : null };
  });
}

/** Mongo filter for the page filters (everything except the tab). */
async function filterOf(f, ppl) {
  const and = [restrictTo({}, 'owner_id', ppl)];
  if (f.type) and.push({ type: f.type });
  if (f.owner) and.push({ owner_id: f.owner });
  if (f.priority) and.push({ priority: f.priority });
  if (f.leadId) and.push({ lead_id: f.leadId });
  if (f.meet === 'yes') and.push({ meet_url: { $ne: '' } });
  if (f.meet === 'no') and.push({ meet_url: '' });
  if (f.from) and.push({ due_at: { $gte: new Date(parseDay(f.from)) } });
  if (f.to) and.push({ due_at: { $lt: new Date(parseDay(f.to) + DAY) } });
  if (f.q) {
    const leadIds = await Lead.distinct('_id', { company: ilike(f.q) });
    and.push({ $or: [{ title: ilike(f.q) }, { lead_id: { $in: leadIds } }] });
  }
  return { $and: and };
}

/** Tab predicates (frontend FU_TABS). */
function tabFilter(tab, now) {
  const T = sod(now);
  switch (tab) {
    case 'today': return { done: false, due_at: { $gte: new Date(T), $lt: new Date(T + DAY) } };
    case 'upcoming': return { done: false, due_at: { $gte: new Date(T + DAY) } };
    case 'overdue': return { done: false, due_at: { $lt: new Date(now) } };
    case 'completed': return { done: true };
    default: return {};
  }
}

/** Number of follow-ups matching `filter` in every tab (tab badges). */
async function tabCounts(filter, now) {
  const T = sod(now);
  const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const open = { $eq: ['$done', false] };
  const [c] = await FollowUp.aggregate([
    { $match: FollowUp.translateAliases(filter) },
    {
      $group: {
        _id: null,
        today: count({ $and: [open, { $gte: ['$due_at', new Date(T)] }, { $lt: ['$due_at', new Date(T + DAY)] }] }),
        upcoming: count({ $and: [open, { $gte: ['$due_at', new Date(T + DAY)] }] }),
        overdue: count({ $and: [open, { $lt: ['$due_at', new Date(now)] }] }),
        completed: count({ $eq: ['$done', true] }),
        all: { $sum: 1 },
      },
    },
  ]);
  return { today: c?.today ?? 0, upcoming: c?.upcoming ?? 0, overdue: c?.overdue ?? 0, completed: c?.completed ?? 0, all: c?.all ?? 0 };
}

const SORT = { due: 'due_at', created: 'created_at', priority: 'priority', title: 'title', type: 'type' };

export async function list(query, user) {
  const now = Date.now();
  const filter = await filterOf(query, await people(user));
  const p = pageParams(query);
  const [col, dir] = sortParam(query.sort, SORT, ['due_at', 'asc']);
  const [rows, counts] = await Promise.all([
    FollowUp.find({ $and: [filter, tabFilter(query.tab, now)] })
      .sort({ [col]: dir === 'desc' ? -1 : 1, _id: 1 }).collation(TEXT_ORDER).skip(p.offset).limit(p.limit).rows(),
    tabCounts(filter, now),
  ]);
  return { items: (await withLeadNames(rows)).map((r) => toFollowUp(r)), meta: { ...p.meta(counts[query.tab]), counts } };
}

async function readable(id, user) {
  const row = await FollowUp.findOne({ id }).rows();
  const ppl = await people(user);
  if (!row || (ppl && !ppl.includes(row.owner_id))) throw notFound('Follow-up');
  return (await withLeadNames([row]))[0];
}

/** Follow-up about to be changed; 404 if missing, 403 if outside the user's scope. */
async function writable(session, id, user) {
  const row = await FollowUp.findOne({ id }).session(session).rows();
  if (!row) throw notFound('Follow-up');
  const ppl = await people(user);
  if (ppl && !ppl.includes(row.owner_id)) throw forbidden();
  return row;
}

export const get = async (id, user) => toFollowUp(await readable(id, user));

/** Due time from `dueAt` (ISO) or the modal's local `date` + `time`; null when missing/invalid. */
function dueOf(m) {
  let d = null;
  if (m.dueAt) d = new Date(m.dueAt);
  else if (m.date && m.time) d = new Date(`${m.date}T${m.time}`);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Owner for a write: own scope → always yourself; team scope → someone in your team. */
async function resolveOwner(session, wanted, user) {
  const { scope, people: ppl } = await peopleScope(user, 'fu');
  let owner = wanted || user.ownerId;
  if (scope === 'own') {
    if (wanted && wanted !== user.pid) throw forbidden();
    owner = user.ownerId || user.pid;
  } else if (ppl && owner && !ppl.includes(owner)) {
    throw forbidden();
  }
  if (!owner || !(await SalesOwner.exists({ id: owner }).session(session))) throw unprocessable('Pick a valid owner.');
  return owner;
}

async function checkLead(session, leadId) {
  if (leadId && !(await Lead.exists({ id: leadId }).session(session))) throw unprocessable('Pick a valid lead.');
}

export async function create(m, user) {
  if (!m.title.trim()) throw unprocessable('Add a title.');
  const due = dueOf(m);
  if (!due) throw unprocessable('Pick a date and time.');
  const id = await tx(async (session) => {
    const owner = await resolveOwner(session, m.ownerId, user);
    await checkLead(session, m.leadId);
    const [dur, remind] = FU_DEFAULTS[m.type] || [0, 0];
    const fid = await nextId('followUp');
    await FollowUp.insertMany([{
      id: fid,
      type: m.type,
      title: m.title.trim(),
      lead_id: m.leadId || null,
      owner_id: owner,
      due_at: due,
      duration_min: m.durationMin ?? dur,
      remind_min: m.remindMin ?? remind,
      priority: m.priority || 'Medium',
      meet_url: m.meetUrl || '',
      attendees: m.attendees || '',
      notes: m.notes || '',
      done: false,
      notified: false,
    }], { session });
    return fid;
  });
  return get(id, user);
}

export async function update(id, m, user) {
  await tx(async (session) => {
    const f = await writable(session, id, user);
    if (m.title !== undefined && !m.title.trim()) throw unprocessable('Add a title.');
    const timeGiven = m.dueAt !== undefined || m.date !== undefined || m.time !== undefined;
    const due = timeGiven ? dueOf(m) : f.due_at;
    if (!due) throw unprocessable('Pick a date and time.');
    const patch = { due_at: due, notified: false };
    if (m.ownerId !== undefined && m.ownerId !== f.owner_id) patch.owner_id = await resolveOwner(session, m.ownerId, user);
    if (m.leadId !== undefined) {
      await checkLead(session, m.leadId);
      patch.lead_id = m.leadId || null;
    }
    if (m.type !== undefined) patch.type = m.type;
    if (m.title !== undefined) patch.title = m.title.trim();
    if (m.durationMin !== undefined) patch.duration_min = m.durationMin;
    if (m.remindMin !== undefined) patch.remind_min = m.remindMin;
    if (m.priority !== undefined) patch.priority = m.priority;
    if (m.meetUrl !== undefined) patch.meet_url = m.meetUrl;
    if (m.attendees !== undefined) patch.attendees = m.attendees;
    if (m.notes !== undefined) patch.notes = m.notes;
    await FollowUp.updateOne({ id }, patch, { session });
  });
  return get(id, user);
}

export async function toggleDone(id, user) {
  await tx(async (session) => {
    const f = await writable(session, id, user);
    await FollowUp.updateOne({ id }, { done: !f.done }, { session });
  });
  return get(id, user);
}

export async function remove(id, user) {
  await tx(async (session) => {
    await writable(session, id, user);
    await FollowUp.deleteOne({ id }, { session });
  });
}

/** Follow-ups entering their reminder window: not done, not notified, remind > 0, now ∈ [due − remind, due + 5 min). */
export async function dueReminders(user) {
  const s = await Setting.findOne({ key: 'reminderAlerts' }).select('value').rows();
  if (s && s.value === false) return [];
  const now = new Date();
  const rows = await FollowUp.find(restrictTo({
    done: false,
    notified: false,
    remind_min: { $gt: 0 },
    due_at: { $gt: new Date(now.getTime() - 5 * MINUTE) },
    $expr: { $gte: [now, { $subtract: ['$due_at', { $multiply: ['$remind_min', MINUTE] }] }] },
  }, 'owner_id', await people(user))).sort({ due_at: 1 }).rows();
  return (await withLeadNames(rows)).map((r) => toFollowUp(r));
}

/** Mark reminders as shown (only ones in the user's scope). */
export async function ackReminders(ids, user) {
  const filter = restrictTo({ _id: { $in: ids } }, 'owner_id', await people(user));
  const matched = await FollowUp.distinct('_id', filter);
  if (matched.length) await FollowUp.updateMany({ _id: { $in: matched } }, { notified: true });
  return { ids: matched };
}
