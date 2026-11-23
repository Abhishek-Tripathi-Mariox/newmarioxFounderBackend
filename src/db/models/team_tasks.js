import { defineModel, text, oneOf, dec, day, ts, REQUIRED } from '../modelKit.js';

/** Team tasks (TT1): work given down the "Reports to" hierarchy, optionally about a project or lead. */
export const TEAM_TASK_STATUSES = ['To do', 'In progress', 'Reopened', 'Done'];

export const TeamTask = defineModel('team_tasks', {
  title: text(REQUIRED),
  notes: text(''),
  priority: oneOf(['High', 'Medium', 'Low'], 'Medium'),
  status: oneOf(TEAM_TASK_STATUSES, 'To do'),
  due_date: day(),
  assignee_id: text(REQUIRED), // → users, CASCADE
  created_by: text(), // → users, SET NULL
  update_note: text(''), // the assignee's latest progress note
  done_at: ts(),
  project_id: text(), // → projects, SET NULL
  lead_id: text(), // → leads, SET NULL
  estimate_hours: dec(2),
  company_id: text('mariox'), // Founders HQ company id (mariox | hroo | arth | a founder-added one); missing on old rows = 'mariox'
}, { indexes: [[{ assignee_id: 1, status: 1 }], [{ company_id: 1 }], [{ created_by: 1 }], [{ project_id: 1 }], [{ lead_id: 1 }]] });
