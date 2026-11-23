import { defineModel, text, oneOf, int, bool, dec, REQUIRED } from '../modelKit.js';

/** Delivery staff ("person id" rj, an …): Team & hours, timesheets, project teams. */
export const TEAMS = ['Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];

export const Member = defineModel('members', {
  name: text(REQUIRED),
  role_title: text(''),
  team: oneOf(TEAMS, REQUIRED),
  hue: int(265),
  shift_hours: dec(2, 8),
  cost_per_hour: dec(2), // null → team default
  active: bool(true),
}, { indexes: [[{ team: 1 }]] });
