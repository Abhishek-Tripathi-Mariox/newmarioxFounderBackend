import { defineModel, text, oneOf, ts, REQUIRED, PK } from '../modelKit.js';

/** Lead timeline entries. Deleted with their lead. */
export const LEAD_ACTIVITY_KINDS = ['status', 'owner', 'call', 'email', 'whatsapp', 'meeting', 'note', 'quote', 'company'];

export const LeadActivity = defineModel('lead_activities', {
  lead_id: text(REQUIRED), // → leads, CASCADE
  kind: oneOf(LEAD_ACTIVITY_KINDS, REQUIRED),
  text: text(REQUIRED),
  actor_user_id: text(), // → users, SET NULL
  at: ts(Date.now),
}, { pk: PK.serial, stamps: false, indexes: [[{ lead_id: 1, at: 1 }], [{ at: 1 }]] });
