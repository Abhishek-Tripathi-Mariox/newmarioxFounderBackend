import { defineModel, text, int, REQUIRED, PK } from '../modelKit.js';

/** Lead sources (dropdown order = position). Keyed by the renameable `name`. */
export const LeadSource = defineModel('lead_sources', {
  name: text(REQUIRED),
  position: int(REQUIRED),
}, { pk: PK.hidden, indexes: [[{ name: 1 }, { unique: true }]] });
