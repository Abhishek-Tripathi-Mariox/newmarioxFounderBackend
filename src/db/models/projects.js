import { defineModel, text, oneOf, int, bool, dec, day, ts, texts, REQUIRED } from '../modelKit.js';

/** Delivery projects (PR-101). */
export const PROJECT_STATUSES = ['Running', 'On hold', 'Completed', 'Planning', 'Cancelled'];

export const Project = defineModel('projects', {
  name: text(REQUIRED),
  client: text(REQUIRED),
  services: texts(),
  status: oneOf(PROJECT_STATUSES, 'Planning'),
  pm_member_id: text(), // → members
  start_date: day(REQUIRED),
  due_date: day(REQUIRED),
  value: dec(2, 0),
  hue: int(265),
  priority: oneOf(['High', 'Medium', 'Low'], 'Medium'),
  brief: text(''),
  portal_on: bool(false),
  portal_token: text(),
  client_email: text(),
  budget_hours: dec(2),
  status_reason: text(''), // '' | Client end | Third party | Internal / team | Payment pending | Scope change | Other
  status_note: text(''),
  status_note_at: ts(),
  expected_delivery_date: day(),
  lock_version: int(0), // bumped by projects.repository.lockProject to serialise transactions on one project
}, {
  indexes: [
    [{ status: 1 }],
    [{ pm_member_id: 1 }],
    [{ services: 1 }],
    [{ portal_token: 1 }, { unique: true, partialFilterExpression: { portal_token: { $type: 'string' } } }],
  ],
});
