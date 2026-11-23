import { defineModel, text, ts } from '../modelKit.js';

/**
 * Last activity per person (`_id` = person_id); idle 30m+ = no activity.
 * `lock_token` / `locked_until`: the per-person workday lock (workday.repository.withPersonLock),
 * held while a check-in / break / timer / end-of-shift change runs; null when free.
 */
export const Presence = defineModel('presence', {
  last_activity_at: ts(Date.now),
  lock_token: text(),
  locked_until: ts(),
}, { pkColumn: 'person_id', stamps: false });
