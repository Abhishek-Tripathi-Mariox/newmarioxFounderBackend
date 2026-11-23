/**
 * Public client portal (no auth): a project is reachable only by the token of a portal that is ON.
 * Ports ClientPortalPreview (what the client sees), clientDecide (milestones) and crAct
 * clientApprove / clientReject (change requests). Client decisions land in activity_feed (kind 'appr').
 */
import { tx } from '../../db/mongo.js';
import { ActivityFeed, ChangeRequest, Milestone } from '../../db/models/index.js';
import { notFound, unprocessable } from '../../core/errors.js';
import * as repo from './projects.repository.js';
import { buildModel, REVIEW_LINKS } from './projects.domain.js';
import { toCr } from '../change-requests/changeRequests.mapper.js';
import { applyDecision } from '../change-requests/changeRequests.service.js';

async function projectByToken(token, session = null) {
  const row = await repo.findProjectByToken(token, session);
  if (!row) throw notFound('Portal');
  return repo.findProject(row.id, session);
}

export async function view(token) {
  const p = await projectByToken(token);
  const [ms, logs, members, counts, crRows] = await Promise.all([
    repo.findMilestones([p.id]), repo.findLogs([p.id]), repo.findMembers(), repo.healthCounts([p.id]),
    ChangeRequest.find({ project_id: p.id, status: { $ne: 'Draft' } }).sort({ raised_at: -1 }).rows(),
  ]);
  const M = buildModel({ projects: [p], milestones: ms, logs, members, ...counts });
  const I = M.info(p);
  const done = I.ms.filter((m) => m.status === 'Done').length;
  const pm = members.find((m) => m.id === p.pmId);
  const crs = crRows.map(toCr);
  return {
    project: { id: p.id, name: p.name, client: p.client, pmName: pm ? pm.name : '—', startDate: p.startDate, dueDate: p.dueDate },
    progress: { pct: I.ms.length ? Math.round((done / I.ms.length) * 100) : 0, done, total: I.ms.length },
    schedule: I.health.label === 'Late' ? 'Behind schedule' : 'On schedule',
    links: p.links.filter((l) => REVIEW_LINKS.includes(l.type)).map(({ type, url }) => ({ type, url })),
    milestones: I.ms.map((m) => ({
      id: m.id, n: m.n, name: m.name, dueDate: m.dueDate, status: m.status,
      state: m.status === 'Done' ? 'Complete' : I.curM && I.curM.id === m.id ? 'In progress' : 'Upcoming',
      approval: m.approval ? { status: m.approval.status, at: m.approval.at, note: m.approval.note } : null,
    })),
    changeRequests: crs.map((c) => ({
      id: c.id, title: c.title, description: c.description, status: c.status,
      statusLabel: c.status === 'Sent to client' ? 'Waiting for your approval' : c.status,
      amount: c.amount, hours: c.hours, extraDays: c.extraDays,
      signature: c.signature ? { name: c.signature.name, at: c.signature.at } : null,
      awaitingDecision: c.status === 'Sent to client',
    })),
  };
}

/** Client decisions show up in the live activity feed (person_id null = the client). */
const feed = (text, session) => ActivityFeed.insertMany([{ person_id: null, kind: 'appr', text }], { session });

/** clientDecide: approve → Done; request changes (note required) → In progress. */
export async function decideMilestone(token, mid, { approve, note }) {
  const n = (note || '').trim();
  if (!approve && !n) throw unprocessable('Add a note so the team knows what to change');
  return tx(async (session) => {
    const p = await projectByToken(token, session);
    const m = await Milestone.findOne({ id: mid, project_id: p.id }).select('name approval_status').session(session).rows();
    if (!m) throw notFound('Milestone');
    if (m.approval_status !== 'Pending') throw unprocessable('This milestone is not waiting for your approval.');
    const st = approve ? 'Approved' : 'Changes requested';
    // Conditional on "still Pending": two concurrent decisions cannot both apply.
    const { modifiedCount } = await Milestone.updateOne(
      { id: mid, approval_status: 'Pending' },
      { status: approve ? 'Done' : 'In progress', approval_status: st, approval_at: new Date(), approval_note: n },
      { session },
    );
    if (!modifiedCount) throw unprocessable('This milestone is not waiting for your approval.');
    await feed(`${p.client || 'Client'} · ${st.toLowerCase()} · ${m.name}`, session);
    return { id: mid, status: approve ? 'Done' : 'In progress', approval: st, message: approve ? 'Milestone approved' : 'Change request sent to the team' };
  });
}

/** clientApprove (typed name ≥ 3 + agree) / clientReject (note required). */
export async function decideCr(token, crId, { approve, name, agree, note }) {
  const nt = (note || '').trim();
  if (approve) {
    if ((name || '').trim().length < 3) throw unprocessable('Type your full name to sign the approval');
    if (!agree) throw unprocessable('Tick the box to confirm you approve the cost and timeline');
  } else if (!nt) throw unprocessable('Add a note so the team knows why');
  return tx(async (session) => {
    const ref = await repo.findProjectByToken(token, session);
    if (!ref) throw notFound('Portal');
    await repo.lockProject(ref.id, session);
    const p = await repo.findProject(ref.id, session);
    const row = await ChangeRequest.findOne({ id: crId, project_id: p.id }).session(session).rows();
    if (!row || row.status === 'Draft') throw notFound('Change request');
    const c = toCr(row);
    if (c.status !== 'Sent to client') throw unprocessable('This change request is not waiting for your approval.');
    const message = await applyDecision(c, p, approve ? 'approve' : 'reject', { note: nt, signer: { name }, via: 'portal' }, session);
    await feed(`${p.client || 'Client'} · ${approve ? 'approved' : 'rejected'} · ${c.id} ${c.title}`, session);
    const out = toCr(await ChangeRequest.findOne({ id: crId }).session(session).rows());
    return { id: out.id, status: out.status, signature: out.signature ? { name: out.signature.name, at: out.signature.at } : null, message };
  });
}
