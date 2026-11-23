import { defineModel, text, ts, REQUIRED } from '../modelKit.js';

/** One running timer per person (`_id` = person_id). */
export const ActiveTimer = defineModel('active_timers', {
  task_id: text(), // → tasks, CASCADE
  project_id: text(REQUIRED), // → projects, CASCADE
  milestone_id: text(), // → milestones, SET NULL
  title: text(REQUIRED),
  started_at: ts(Date.now),
}, { pkColumn: 'person_id', stamps: false, indexes: [[{ task_id: 1 }], [{ project_id: 1 }]] });
