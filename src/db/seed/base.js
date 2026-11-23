/**
 * Base reference data: roles (same permission matrix as the frontend), master lists and settings.
 * Idempotent — safe to run on every deploy (upserts, never deletes).
 */
import { LeadSource, LeadStage, Role, Service, Setting } from '../models/index.js';
import { PARTNER_ROLE } from '../models/roles.js';
import { MODS, clampCell } from '../../core/permissions.js';

/** Modules and their actions: src/core/permissions.js (pp_* = the Mariox Partners admin console sections). */
/** Attendance & reports: View only by default (Edit = act on people's day). */
const VIEW = (scope) => P(1, 0, 0, 0, scope);
const P = (v, c, e, d, scope = 'all') => ({ v: !!v, c: !!c, e: !!e, d: !!d, scope });
const NONE = P(0, 0, 0, 0);
const ALL = P(1, 1, 1, 1);
/** Team tasks: every staff role gives tasks down its "Reports to" team (Admin / Super Admin: anyone). */
const TT = P(1, 1, 1, 1, 'team');
const mk = (o) => Object.fromEntries(MODS.map((k) => [k, clampCell(k, o[k] || (k === 'tt' ? TT : NONE))]));

export const ROLES = [
  { id: 'r-super', name: 'Super Admin', description: 'Full access to everything, including roles', hue: 265, locked: true, perms: mk(Object.fromEntries(MODS.map((k) => [k, ALL]))) },
  { id: 'r-admin', name: 'Admin', description: 'Everything except deleting users', hue: 220, perms: mk({ ...Object.fromEntries(MODS.map((k) => [k, ALL])), users: P(1, 1, 1, 0), att: VIEW('all'), ...Object.fromEntries(MODS.filter((k) => k.startsWith('pp_')).map((k) => [k, NONE])) }) },
  { id: 'r-sm', name: 'Sales Manager', description: 'Owns the pipeline and the sales team', hue: 150, perms: mk({ dash: P(1), leads: ALL, fu: ALL, projects: P(1), att: VIEW('team') }) },
  { id: 'r-se', name: 'Sales Executive', description: 'Works their own leads and follow-ups', hue: 190, perms: mk({ dash: P(1, 0, 0, 0, 'own'), leads: P(1, 1, 1, 0, 'own'), fu: P(1, 1, 1, 1, 'own') }) },
  { id: 'r-pm', name: 'Project Manager', description: 'Runs projects, milestones, tasks and the team', hue: 300, perms: mk({ projects: P(1, 1, 1, 0), tasks: ALL, bugs: ALL, ts: P(1, 1, 1, 0), team: P(1, 0, 1, 0), fu: P(1, 1, 1, 0, 'own'), att: VIEW('team') }) },
  { id: 'r-tl', name: 'Team Lead', description: 'Leads a team, assigns tasks, reviews hours', hue: 70, perms: mk({ projects: P(1, 0, 0, 0, 'team'), tasks: P(1, 1, 1, 0, 'team'), bugs: P(1, 1, 1, 0, 'team'), ts: P(1, 1, 1, 0, 'team'), team: P(1, 0, 0, 0, 'team'), att: VIEW('team') }) },
  { id: 'r-tm', name: 'Team Member', description: 'Developers and designers', hue: 250, perms: mk({ projects: P(1, 0, 0, 0, 'own'), tasks: P(1, 0, 1, 0, 'own'), bugs: P(1, 1, 1, 0, 'own'), ts: P(1, 1, 1, 0, 'own') }) },
  { id: 'r-qa', name: 'QA Engineer', description: 'Reports, retests and closes bugs', hue: 25, perms: mk({ projects: P(1, 0, 0, 0, 'team'), tasks: P(1, 0, 0, 0, 'team'), bugs: ALL, ts: P(1, 1, 1, 0, 'own') }) },
  { id: 'r-client', name: 'Client', description: 'External · sees their project, reports bugs', hue: 45, perms: mk({ projects: P(1, 0, 0, 0, 'own'), bugs: P(1, 1, 0, 0, 'own'), tt: NONE }) },
  // Mariox Partners partners: sign in with the one portal login but only ever open the partner app.
  { id: PARTNER_ROLE, name: 'Partner', description: 'External · Mariox Partners only, no internal data', hue: 330, locked: true, perms: {} },
];

export const STAGES = [['New', 250, true], ['Contacted', 220], ['Qualified', 190], ['Proposal Sent', 295], ['Negotiation', 70], ['Won', 150, true], ['Lost', 25, true]];
export const SOURCES = ['Website', 'LinkedIn', 'Upwork', 'Clutch', 'Referral', 'Google Ads', 'IndiaMART', 'Email Campaign'];
export const SERVICES = ['Mobile App', 'Web Development', 'UI/UX Design', 'Custom Software', 'E-commerce', 'AI / ML', 'Digital Marketing'];
export const SETTINGS = { currency: 'INR', defaultLeadsView: 'Kanban', reminderAlerts: true };

/** Insert-if-missing for a name-keyed master list (existing rows — maybe renamed or reordered by users — are kept). */
const insertMissing = (rows, stamp) => rows.map((row) => ({
  updateOne: { filter: { name: row.name }, update: { $setOnInsert: { ...row, created_at: stamp, updated_at: stamp } }, upsert: true },
}));

/**
 * Upsert the base data. Built-in roles are refreshed (name, description, hue, locked, perms);
 * stages, sources, services and settings are only added when missing.
 * All rows of one run share one timestamp, like a single Postgres statement's now().
 */
export async function seedBase(session = null) {
  const stamp = new Date();
  const opts = { session, timestamps: false };
  await Role.bulkWrite(ROLES.map(({ id, ...fields }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { ...fields, locked: !!fields.locked, updated_at: stamp }, $setOnInsert: { created_at: stamp } },
      upsert: true,
    },
  })), opts);
  await LeadStage.bulkWrite(insertMissing(STAGES.map(([name, hue, core], i) => ({ name, hue, position: i, is_core: !!core })), stamp), opts);
  await LeadSource.bulkWrite(insertMissing(SOURCES.map((name, i) => ({ name, position: i })), stamp), opts);
  await Service.bulkWrite(insertMissing(SERVICES.map((name, i) => ({ name, position: i })), stamp), opts);
  await Setting.bulkWrite(Object.entries(SETTINGS).map(([key, value]) => ({
    updateOne: { filter: { _id: key }, update: { $setOnInsert: { value, created_at: stamp, updated_at: stamp } }, upsert: true },
  })), opts);
}
