/** MongoDB reads and writes for leads, their activities, quotes and the masters they reference. */
import { TEXT_ORDER } from '../../db/modelKit.js';
import {
  ActivityFeed, FollowUp, Lead, LeadActivity, LeadSource, LeadStage, Quote, SalesOwner, Setting, TeamTask, User,
} from '../../db/models/index.js';
import { restrictTo } from '../../core/scope.js';

/** Lead ids → time of their latest activity (Date). */
async function lastActivityAt(leadIds, session = null) {
  if (!leadIds.length) return new Map();
  const rows = await LeadActivity.aggregate([
    { $match: { lead_id: { $in: leadIds } } },
    { $group: { _id: '$lead_id', at: { $max: '$at' } } },
  ]).session(session);
  return new Map(rows.map((r) => [r._id, r.at]));
}

/** Scoped leads with their last activity time `last_act_at` (for insights). `people` null = all owners. */
export async function scopedLeads(people, session = null) {
  const rows = await Lead.find(restrictTo({}, 'owner_id', people)).session(session).rows();
  const last = await lastActivityAt(rows.map((r) => r.id), session);
  return rows.map((r) => ({ ...r, last_act_at: last.get(r.id) ?? null }));
}

/** Follow-ups attached to the given (scoped) leads that matter for insights: open ones + done & due. */
export async function insightFollowUps(people, session = null) {
  const leadIds = await Lead.distinct('_id', restrictTo({}, 'owner_id', people)).session(session);
  return FollowUp.find({ lead_id: { $in: leadIds }, $or: [{ done: false }, { due_at: { $lte: new Date() } }] })
    .select('lead_id done due_at type title').session(session).rows();
}

export const findLead = (id, session = null) => Lead.findOne({ id }).session(session).rows();

const namesByPosition = async (Model, session) => (await Model.find().sort({ position: 1 }).select('name').session(session).rows()).map((r) => r.name);
const nameExists = async (Model, name, session) => !!(await Model.exists({ name }).session(session));

export const stageNames = (session = null) => namesByPosition(LeadStage, session);
export const stageExists = (name, session = null) => nameExists(LeadStage, name, session);
export const sourceNames = (session = null) => namesByPosition(LeadSource, session);
export const sourceExists = (name, session = null) => nameExists(LeadSource, name, session);

export const salesOwners = (session = null) => SalesOwner.find().sort({ name: 1, _id: 1 }).collation(TEXT_ORDER).select('name').session(session).rows();
export const ownerById = (id, session = null) => SalesOwner.findOne({ id }).select('name').session(session).rows();
export const firstOwner = (session = null) => SalesOwner.findOne({ active: true }).sort({ _id: 1 }).select('name').session(session).rows();

/** Every sales owner (id, name, active) and every user linked to one (owner_id, email) — CSV import lookups. */
export const allOwners = (session = null) => SalesOwner.find().sort({ _id: 1 }).select('name active').session(session).rows();
export const ownerUsers = (session = null) => User.find({ owner_id: { $ne: null } }).select('owner_id email').session(session).rows();
/** id, email and phone of every lead (CSV import duplicate check). */
export const leadContacts = (session = null) => Lead.find().select('email phone').session(session).rows();

export async function setting(key, fallback, session = null) {
  const r = await Setting.findOne({ key }).select('value').session(session).rows();
  return r ? r.value : fallback;
}

export const insertLead = async (row, session = null) => (await Lead.insertRows([row], session))[0];
export const updateLead = (id, patch, session = null) => Lead.findOneAndUpdate({ id }, patch, { new: true, session }).rows();

export const addActivities = (rows, session = null) => (rows.length ? LeadActivity.insertMany(rows, { session }) : Promise.resolve());

/** Activities (oldest first) of the given leads, each with the actor's name as `actor_name`. */
async function activitiesWhere(filter, session) {
  const rows = await LeadActivity.find(filter).sort({ at: 1, _id: 1 }).session(session).rows();
  const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter(Boolean))];
  const actors = actorIds.length ? await User.find({ id: { $in: actorIds } }).select('name').session(session).rows() : [];
  const nameOf = new Map(actors.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ ...r, actor_name: nameOf.get(r.actor_user_id) ?? null }));
}

export const activitiesOf = (leadId, session = null) => activitiesWhere({ lead_id: leadId }, session);
/** Activities / quotes of many leads in one query each (list ?include=). */
export const activitiesOfMany = (leadIds, session = null) => activitiesWhere({ lead_id: { $in: leadIds } }, session);
export const quotesOfMany = (leadIds, session = null) => Quote.find({ lead_id: { $in: leadIds } }).sort({ created_at: 1, _id: 1 }).session(session).rows();

export const quotesOf = (leadId, session = null) => Quote.find({ lead_id: leadId }).sort({ created_at: 1, _id: 1 }).session(session).rows();
export const findQuote = (leadId, id, session = null) => Quote.findOne({ lead_id: leadId, id }).session(session).rows();
/** Ids of the quotes whose id starts with `prefix`. */
export const quoteIdsStartingWith = (prefix, session = null) =>
  Quote.distinct('_id', { _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }).session(session);
export const insertQuote = async (row, session = null) => (await Quote.insertRows([row], session))[0];
export const updateQuote = (id, patch, session = null) => Quote.findOneAndUpdate({ id }, patch, { new: true, session }).rows();

export const followUpsOf = (leadId, session = null) => FollowUp.find({ lead_id: leadId }).sort({ due_at: 1 }).session(session).rows();

/** Move everything hanging off lead `fromId` to lead `toId` (merge). */
export async function moveChildren(fromId, toId, session = null) {
  for (const Model of [FollowUp, Quote, LeadActivity, ActivityFeed]) {
    await Model.updateMany({ lead_id: fromId }, { lead_id: toId }, { session });
  }
}

/**
 * Delete a lead with the old foreign-key actions: its activities, quotes and follow-ups go with it
 * (CASCADE); activity-feed lines and team tasks keep existing without the link (SET NULL).
 */
export async function deleteLead(id, session = null) {
  for (const Model of [LeadActivity, Quote, FollowUp]) await Model.deleteMany({ lead_id: id }, { session });
  for (const Model of [ActivityFeed, TeamTask]) await Model.updateMany({ lead_id: id }, { lead_id: null }, { session });
  await Lead.deleteOne({ id }, { session });
}
