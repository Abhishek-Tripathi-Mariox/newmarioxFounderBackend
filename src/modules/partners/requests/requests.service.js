import { PpBooking, PpScope, PpTechRequest, PpTicket } from '../../../db/models/index.js';
import { nextCode, withFreshCode } from '../lib/codes.js';
import { deleteFile, openFile } from '../lib/files.js';
import { PpError, parseBody } from '../lib/http.js';
import { eq, runList } from '../lib/list.js';
import { scope } from '../lib/session.js';
import { acceptSchema, requestCreate, requestReview, reviewSlotError } from './requests.schemas.js';

/** Partner requests to Mariox (mariox-saas src/app/api/requests/**, src/lib/requests.ts). */

const KINDS = {
  scope: { model: PpScope, create: requestCreate.scope, search: ['client', 'project', 'needs', 'comment'] },
  booking: { model: PpBooking, create: requestCreate.booking, search: ['client', 'office', 'purpose', 'team'] },
  tech: { model: PpTechRequest, create: requestCreate.tech, search: ['client', 'type', 'assignee', 'context'] },
  ticket: { model: PpTicket, create: requestCreate.ticket, search: ['code', 'subject', 'category', 'body'] },
};

/** Config for scope | booking | tech | ticket, else 404. */
export function requestKind(kind) {
  const k = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!k) throw new PpError(404, `Unknown request type "${kind}"`);
  return k;
}

export async function list(s, kind, req) {
  const { model, search } = requestKind(kind);
  const spec = {
    search,
    sorts: ['createdAt', 'updatedAt', 'status', 'date'],
    defaultSort: '-createdAt',
    filters: { status: eq('status'), ...(s.role === 'admin' ? { owner: eq('owner') } : {}) },
  };
  const { items, meta } = await runList(model, scope(s), req, spec, { path: 'owner', select: 'name company partnerCode' });
  return { items, meta };
}

/** Extra fields filled in on create, per kind. */
async function createDefaults(kind, data, owner) {
  if (kind === 'scope') {
    // Only files this partner uploaded can be attached.
    for (const a of data.attachments || []) {
      const f = await openFile(a.fileId);
      if (String(f.owner) !== owner) throw new PpError(400, 'Attachment not found');
    }
    return { submitted: (data.lines || []).reduce((a, l) => a + (l.amount || 0), 0) };
  }
  if (kind === 'ticket') return { status: data.escalate ? 'assigned' : 'requested' };
  return {};
}

export async function create(s, kind, req) {
  const { model, create: schema } = requestKind(kind);
  const data = parseBody(req, schema);
  const doc = { ...data, ...(await createDefaults(kind, data, s.sub)), owner: s.sub };
  if (kind !== 'ticket') return model.create(doc);
  // Ticket codes TK-2001, TK-2002, …
  return withFreshCode(() => nextCode(PpTicket, 'code', 'TK', 4, 2001), (code) => model.create({ ...doc, code }), 'code');
}

/** Admins review any request; a partner may only accept a revised amount on their own scope. */
export async function update(s, kind, id, req) {
  const { model } = requestKind(kind);
  if (s.role !== 'admin') {
    const { accept } = parseBody(req, acceptSchema);
    if (kind !== 'scope' || !accept) throw new PpError(403, 'Admins only');
    // Conditional update: only a `revised` scope can be accepted, even under concurrent clicks.
    const item = await model.findOne({ _id: id, owner: s.sub });
    if (!item) throw new PpError(404, 'Request not found');
    if (item.status !== 'revised') throw new PpError(400, 'Only a revised amount can be accepted');
    const comment = `${item.comment ? `${item.comment} ` : ''}Partner accepted the revised amount.`;
    const accepted = await model.findOneAndUpdate({ _id: id, owner: s.sub, status: 'revised' }, { status: 'approved', comment }, { new: true });
    if (!accepted) throw new PpError(400, 'Only a revised amount can be accepted');
    return accepted;
  }

  const review = parseBody(req, requestReview);
  const late = reviewSlotError(review);
  if (late) throw new PpError(400, late);
  const item = await model.findByIdAndUpdate(id, review, { new: true });
  if (!item) throw new PpError(404, 'Request not found');
  return item;
}

/** A partner withdraws their own request; admins delete any. Attachments are removed from storage. */
export async function remove(s, kind, id) {
  const { model } = requestKind(kind);
  const item = await model.findOneAndDelete({ _id: id, ...scope(s) });
  if (!item) throw new PpError(404, 'Request not found');
  for (const f of item.attachments ?? []) await deleteFile(f.fileId);
}

/** Booked slots at an office on a day, across all partners (no partner details). */
export async function availability(office, date) {
  if (!office || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PpError(400, 'office and date (YYYY-MM-DD) are required');
  return PpBooking.distinct('time', { office, date, status: { $nin: ['Declined', 'Completed'] } });
}
