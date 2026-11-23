import { defineModel, text, ts, REQUIRED, PK } from '../modelKit.js';

/** Bug timeline ("Status → Fixed", "Comment: …"). Deleted with their bug. */
export const BugEvent = defineModel('bug_events', {
  bug_id: text(REQUIRED), // → bugs, CASCADE
  text: text(REQUIRED),
  actor_user_id: text(), // → users, SET NULL
  at: ts(Date.now),
}, { pk: PK.serial, stamps: false, indexes: [[{ bug_id: 1, at: 1 }]] });
