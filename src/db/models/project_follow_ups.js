import { defineModel, text, oneOf, int, bool, ts, REQUIRED } from '../modelKit.js';

/** Project follow-ups (PF1): client syncs, demos, UAT calls. Deleted with their project. */
export const ProjectFollowUp = defineModel('project_follow_ups', {
  project_id: text(REQUIRED), // → projects, CASCADE
  type: oneOf(['Meeting', 'Call', 'Task', 'Reminder'], REQUIRED),
  title: text(REQUIRED),
  owner_member_id: text(REQUIRED), // → members
  due_at: ts(REQUIRED),
  duration_min: int(0),
  remind_min: int(0),
  priority: oneOf(['High', 'Medium', 'Low'], 'Medium'),
  meet_url: text(''),
  attendees: text(''),
  notes: text(''),
  done: bool(false),
  notified: bool(false),
  created_by: text(), // → users, SET NULL
}, { indexes: [[{ project_id: 1, due_at: 1 }], [{ owner_member_id: 1, due_at: 1 }], [{ due_at: 1 }]] });
