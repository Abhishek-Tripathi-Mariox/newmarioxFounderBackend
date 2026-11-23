import { defineModel, text, ts, REQUIRED, PK } from '../modelKit.js';

/** Live-now activity feed (in out start stop break call email …). person_id null = client. */
export const ActivityFeed = defineModel('activity_feed', {
  person_id: text(),
  kind: text(REQUIRED),
  text: text(REQUIRED),
  lead_id: text(), // → leads, SET NULL
  at: ts(Date.now),
}, { pk: PK.serial, stamps: false, indexes: [[{ at: 1 }], [{ lead_id: 1 }]] });
