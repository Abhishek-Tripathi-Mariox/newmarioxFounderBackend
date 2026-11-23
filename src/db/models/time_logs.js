import { defineModel, text, dec, day, REQUIRED } from '../modelKit.js';

/** Hours logged (L12). source = manual | timer | shift-report | seed. Deleted with their project. */
export const TimeLog = defineModel('time_logs', {
  member_id: text(REQUIRED), // → members
  project_id: text(REQUIRED), // → projects, CASCADE
  milestone_id: text(), // → milestones, SET NULL
  day: day(REQUIRED),
  hours: { ...dec(2, REQUIRED), validate: { validator: (h) => h > 0 && h <= 24, message: 'hours must be > 0 and ≤ 24' } },
  note: text(''),
  source: text('manual'),
}, { indexes: [[{ member_id: 1, day: 1 }], [{ project_id: 1, day: 1 }], [{ milestone_id: 1 }], [{ day: 1 }]] });
