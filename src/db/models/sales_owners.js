import { defineModel, text, int, bool, REQUIRED } from '../modelKit.js';

/**
 * Sales "person ids" (ak, ps …): owners of leads and follow-ups. `founder` marks the profile of a
 * Founder / Co-founder (users.hq_seat, modules/people/founderOwners.js): they own and assign leads,
 * but aren't sales staff, so Live, attendance and reports leave them out.
 */
export const SalesOwner = defineModel('sales_owners', {
  name: text(REQUIRED),
  hue: int(265),
  active: bool(true),
  founder: bool(false),
});
