import { defineModel, text, oneOf, dec, day, json, REQUIRED } from '../modelKit.js';

/** Project tasks (T12). checklist = [{ t, done }], log = [{ d, t }]. Deleted with their project. */
export const TASK_STATUSES = ['To do', 'In progress', 'Blocked', 'In review', 'Done'];

export const Task = defineModel('tasks', {
  project_id: text(REQUIRED), // → projects, CASCADE
  milestone_id: text(), // → milestones, SET NULL
  title: text(REQUIRED),
  description: text(''),
  assignee_id: text(), // → members, SET NULL
  status: oneOf(TASK_STATUSES, 'To do'),
  priority: oneOf(['High', 'Medium', 'Low'], 'Medium'),
  due_date: day(),
  estimate_hours: dec(2, 0),
  checklist: json([]),
  cr_id: text(), // → change_requests, SET NULL
  log: json([]),
}, { indexes: [[{ project_id: 1 }], [{ assignee_id: 1 }], [{ status: 1 }], [{ milestone_id: 1 }], [{ cr_id: 1 }]] });
