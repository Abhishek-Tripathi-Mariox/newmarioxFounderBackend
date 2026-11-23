import { defineModel, text, oneOf, int, dec, day, ts, REQUIRED } from '../modelKit.js';

/** Project milestones (PR-101-M1, or PR-101-CR-101-1 for a change request). Deleted with their project. */
export const MILESTONE_STATUSES = ['Not started', 'In progress', 'In review', 'Done'];
export const APPROVAL_STATUSES = ['Pending', 'Approved', 'Changes requested'];

export const Milestone = defineModel('milestones', {
  project_id: text(REQUIRED), // → projects, CASCADE
  n: int(REQUIRED),
  name: text(REQUIRED),
  alloc_hours: dec(2, 0),
  due_date: day(),
  status: oneOf(MILESTONE_STATUSES, 'Not started'),
  cr_id: text(), // → change_requests, SET NULL
  approval_status: oneOf(APPROVAL_STATUSES), // client portal approval
  approval_asked_at: ts(),
  approval_at: ts(),
  approval_note: text(),
  notes: text(''),
}, { indexes: [[{ project_id: 1, n: 1 }, { unique: true }], [{ cr_id: 1 }]] });
