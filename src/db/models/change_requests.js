import { defineModel, text, oneOf, int, dec, ts, texts, json, REQUIRED } from '../modelKit.js';

/** Change requests (CR-101-1). tasks = planned work [{ t, a, h }]. Deleted with their project. */
export const CR_STATUSES = ['Draft', 'Sent to client', 'Approved', 'In progress', 'Done', 'Rejected'];

export const ChangeRequest = defineModel('change_requests', {
  project_id: text(REQUIRED), // → projects, CASCADE
  n: int(REQUIRED),
  title: text(REQUIRED),
  description: text(''),
  requested_by: oneOf(['Client', 'Internal'], 'Client'),
  requested_by_name: text(''),
  hours: dec(2, REQUIRED),
  rate: dec(2, REQUIRED),
  amount: dec(2, REQUIRED),
  extra_days: int(0),
  priority: text('Medium'),
  target: text('new'), // 'new' or an existing milestone id
  status: oneOf(CR_STATUSES, 'Draft'),
  milestone_id: text(), // → milestones, SET NULL
  team: texts(),
  tasks: json([]),
  note: text(),
  raised_at: ts(Date.now),
  sent_at: ts(),
  decided_at: ts(),
  done_at: ts(),
  // Approval record (typed signature in the client portal, or recorded by the PM)
  sig_name: text(),
  sig_title: text(),
  sig_at: ts(),
  sig_via: text(),
  sig_note: text(),
}, { indexes: [[{ project_id: 1, n: 1 }, { unique: true }], [{ milestone_id: 1 }], [{ status: 1 }]] });
