import { defineModel, text, json, REQUIRED, PK } from '../modelKit.js';

/** Team task timeline: created | status | note | comment | attach | detach | edit | assign. */
export const TeamTaskEvent = defineModel('team_task_events', {
  task_id: text(REQUIRED), // → team_tasks, CASCADE
  user_id: text(), // → users, SET NULL
  kind: text(REQUIRED),
  from_val: text(),
  to_val: text(),
  text: text(),
  meta: json({}),
}, { pk: PK.serial, stamps: 'created', indexes: [[{ task_id: 1, created_at: 1 }]] });
