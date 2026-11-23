import { defineModel, text, int, bool, REQUIRED, PK } from '../modelKit.js';

/** Lead pipeline stages. Keyed by the renameable `name` (unique), so `_id` is a hidden ObjectId. */
export const LeadStage = defineModel('lead_stages', {
  name: text(REQUIRED),
  hue: int(265),
  position: int(REQUIRED),
  is_core: bool(false), // New / Won / Lost
}, { pk: PK.hidden, indexes: [[{ name: 1 }, { unique: true }]] });
