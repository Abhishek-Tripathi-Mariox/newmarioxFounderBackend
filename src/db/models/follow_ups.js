import { defineModel, text, oneOf, int, bool, ts, REQUIRED } from '../modelKit.js';

/** Sales follow-ups (F12). Deleted with their lead. */
export const FOLLOW_UP_TYPES = ['Meeting', 'Call', 'Task', 'Reminder'];
export const PRIORITIES = ['High', 'Medium', 'Low'];

export const FollowUp = defineModel('follow_ups', {
  type: oneOf(FOLLOW_UP_TYPES, REQUIRED),
  title: text(REQUIRED),
  lead_id: text(), // → leads, CASCADE
  owner_id: text(REQUIRED), // → sales_owners
  due_at: ts(REQUIRED),
  duration_min: int(0),
  remind_min: int(0),
  priority: oneOf(PRIORITIES, 'Medium'),
  meet_url: text(''),
  attendees: text(''),
  notes: text(''),
  done: bool(false),
  notified: bool(false),
}, { indexes: [[{ owner_id: 1, due_at: 1 }], [{ lead_id: 1 }], [{ due_at: 1 }]] });
