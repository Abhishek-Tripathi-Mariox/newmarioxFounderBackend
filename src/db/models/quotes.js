import { defineModel, text, oneOf, int, bool, dec, ts, json, REQUIRED } from '../modelKit.js';

/** Quotes on a lead (Q-1004-1). items = [{ d: description, q: qty, r: rate }]. Deleted with their lead. */
export const QUOTE_STATUSES = ['Draft', 'Sent', 'Viewed', 'Accepted', 'Declined'];

export const Quote = defineModel('quotes', {
  lead_id: text(REQUIRED), // → leads, CASCADE
  status: oneOf(QUOTE_STATUSES, 'Draft'),
  items: json(REQUIRED),
  discount_pct: dec(2, 0),
  gst: bool(true),
  valid_days: int(15),
  terms: text(''),
  net: dec(2, 0),
  total: dec(2, 0),
  sent_at: ts(),
  viewed_at: ts(),
  accepted_at: ts(),
  declined_at: ts(),
}, { indexes: [[{ lead_id: 1 }]] });
