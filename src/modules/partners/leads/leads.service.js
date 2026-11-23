import { PpLead, PpUser } from '../../../db/models/index.js';
import { PpError } from '../lib/http.js';
import { eq, runList } from '../lib/list.js';
import { LOST, WON, getPipeline, stageKeys, stageName } from '../lib/pipeline.js';
import { ownerFor, scope } from '../lib/session.js';
import { notPast } from '../lib/validate.js';

/** Partner leads (mariox-saas src/app/api/leads/**). Partners see and change only their own. */

const OWNER_FIELDS = { path: 'owner', select: 'name company partnerCode commissionRate' };
const LIST = {
  search: ['company', 'project', 'contact', 'email', 'phone', 'city'],
  sorts: ['updatedAt', 'createdAt', 'value', 'expectedClose', 'company'],
  defaultSort: '-updatedAt',
  filters: { stage: eq('stage'), source: eq('source'), priority: eq('priority') },
};

/** Activity / task dates are the UTC calendar day, as in the source. */
const today = () => new Date().toISOString().slice(0, 10);

export async function list(s, req, ownerParam) {
  const base = { ...scope(s), ...(s.role === 'admin' && ownerParam ? { owner: ownerParam } : {}) };
  const { items, meta } = await runList(PpLead, base, req, LIST, OWNER_FIELDS);
  return { leads: items, meta };
}

export async function create(s, { owner: requested, ...data }) {
  const owner = ownerFor(s, requested);
  if (owner === s.sub && s.role === 'admin') throw new PpError(400, 'Choose the partner this lead belongs to');
  if (s.role === 'admin' && !(await PpUser.exists({ _id: owner, role: 'partner' }))) throw new PpError(400, 'Unknown partner');

  const pipe = await getPipeline();
  const stage = data.stage ?? pipe.stages[0].key;
  if (!stageKeys(pipe).includes(stage)) throw new PpError(400, 'Unknown stage');

  return PpLead.create({
    ...data,
    stage,
    owner,
    // Every new lead starts with a first call tomorrow.
    tasks: [{ text: 'First call', due: new Date(Date.now() + 864e5).toISOString().slice(0, 10), done: false }],
    activities: [{ type: 'note', text: s.role === 'admin' ? 'Lead created by Mariox' : 'Lead created', date: today() }],
  });
}

/** The lead, within the caller's scope, or 404. */
export async function find(s, id) {
  const lead = await PpLead.findOne({ _id: id, ...scope(s) });
  if (!lead) throw new PpError(404, 'Lead not found');
  return lead;
}

export async function get(s, id) {
  const lead = await find(s, id);
  await lead.populate(OWNER_FIELDS);
  return lead;
}

/** Edit fields, move stage (logged), reassign (admins), add activity, add / toggle / remove tasks. */
export async function update(s, lead, { addActivity, addTask, toggleTask, removeTask, owner, ...fields }) {
  if (fields.stage !== undefined && fields.stage !== lead.stage) {
    const pipe = await getPipeline();
    if (!stageKeys(pipe).includes(fields.stage)) throw new PpError(400, 'Unknown stage');
    const text = fields.stage === LOST ? `Marked lost: ${fields.lostReason || 'Not specified'}` : `Moved to ${stageName(pipe, fields.stage)}`;
    lead.activities.unshift({ type: fields.stage === WON ? 'won' : 'stage', text, date: today() });
  }
  if (fields.expectedClose && fields.expectedClose !== lead.expectedClose) {
    const e = notPast(fields.expectedClose, 'Expected close');
    if (e) throw new PpError(400, e);
  }
  lead.set(fields);

  if (owner && s.role === 'admin' && owner !== String(lead.owner)) {
    const to = await PpUser.findOne({ _id: owner, role: 'partner' }).select('name');
    if (!to) throw new PpError(400, 'Unknown partner');
    lead.owner = to._id;
    lead.activities.unshift({ type: 'note', text: `Reassigned to ${to.name} by Mariox`, date: today() });
  }

  if (addActivity) lead.activities.unshift({ ...addActivity, date: today() });
  if (addTask) lead.tasks.push({ ...addTask, done: false });
  if (toggleTask) {
    const t = lead.tasks.id(toggleTask);
    if (t) {
      t.done = !t.done;
      if (t.done) lead.activities.unshift({ type: 'task', text: t.text, date: today() });
    }
  }
  if (removeTask) lead.tasks.pull({ _id: removeTask });

  await lead.save();
  await lead.populate(OWNER_FIELDS);
  return lead;
}
