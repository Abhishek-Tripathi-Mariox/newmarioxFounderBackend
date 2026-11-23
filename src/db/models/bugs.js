import { defineModel, text, oneOf, day, REQUIRED } from '../modelKit.js';

/** Bugs (BUG-1001). Deleted with their project. */
export const BUG_STATUSES = ['Open', 'In progress', 'Fixed', 'Retest', 'Reopened', 'Closed'];
export const SEVERITIES = ['Critical', 'Major', 'Minor', 'Trivial'];

export const Bug = defineModel('bugs', {
  project_id: text(REQUIRED), // → projects, CASCADE
  milestone_id: text(), // → milestones, SET NULL
  title: text(REQUIRED),
  dept: text(REQUIRED),
  env: text(REQUIRED),
  severity: oneOf(SEVERITIES, REQUIRED),
  priority: oneOf(['High', 'Medium', 'Low'], 'Medium'),
  status: oneOf(BUG_STATUSES, 'Open'),
  assignee_id: text(), // → members, SET NULL
  reporter: text(REQUIRED), // member id or 'client'
  reported_on: day(REQUIRED),
  due_date: day(),
  build: text(''),
  steps: text(''),
  expected: text(''),
  actual: text(''),
  link: text(''),
}, { indexes: [[{ project_id: 1 }], [{ assignee_id: 1 }], [{ status: 1 }], [{ milestone_id: 1 }]] });
