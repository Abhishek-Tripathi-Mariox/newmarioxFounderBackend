import { defineModel, text, oneOf, ts, json, REQUIRED, PK } from '../modelKit.js';

/** Check-in / out and breaks. meta (break) = { type, planMin, note }. */
export const ATTENDANCE_KINDS = ['login', 'logout', 'break', 'resume'];

export const AttendanceEvent = defineModel('attendance_events', {
  person_id: text(REQUIRED), // member id or sales-owner id
  kind: oneOf(ATTENDANCE_KINDS, REQUIRED),
  at: ts(Date.now),
  meta: json({}),
}, { pk: PK.serial, stamps: false, indexes: [[{ person_id: 1, at: 1 }], [{ at: 1 }]] });
