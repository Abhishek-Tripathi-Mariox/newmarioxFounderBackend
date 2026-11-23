import { defineModel, text, int, bool, day, ts, json, REQUIRED, PK } from '../modelKit.js';

/** End-of-shift reports, one per person per day. */
export const ShiftReport = defineModel('shift_reports', {
  person_id: text(REQUIRED),
  day: day(REQUIRED),
  is_sales: bool(false),
  done: text(''),
  blockers: text(''),
  plan: text(''),
  outcome: text(''),
  calls: int(0),
  meetings: int(0),
  rows: json([]), // [{ p, ms, h, note }]
  pm_rows: json([]), // [{ p, st, note }]
  internal_rows: json([]), // [{ cat, h, note }]
  lead_rows: json([]), // [{ lead, kind, note, next }]
  team_tasks: json([]), // [{ id, title, done, was, h, note, p, to }] team tasks reported (done = completed in this report)
  submitted_at: ts(Date.now),
}, { pk: PK.serial, stamps: false, indexes: [[{ person_id: 1, day: 1 }, { unique: true }], [{ day: 1 }]] });
