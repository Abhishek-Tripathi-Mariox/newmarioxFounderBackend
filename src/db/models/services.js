import { defineModel, text, int, REQUIRED, PK } from '../modelKit.js';

/** Services offered (leads / projects tag these by name). Keyed by the renameable `name`. */
export const Service = defineModel('services', {
  name: text(REQUIRED),
  position: int(REQUIRED),
}, { pk: PK.hidden, indexes: [[{ name: 1 }, { unique: true }]] });
