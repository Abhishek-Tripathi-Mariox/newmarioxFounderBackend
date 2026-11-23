import { defineModel, text, ts, REQUIRED, PK } from '../modelKit.js';

/** Change-request history lines. Deleted with their change request. */
export const CrHistory = defineModel('cr_history', {
  cr_id: text(REQUIRED), // → change_requests, CASCADE
  text: text(REQUIRED),
  at: ts(Date.now),
}, { pk: PK.serial, stamps: false, indexes: [[{ cr_id: 1, at: 1 }]] });
