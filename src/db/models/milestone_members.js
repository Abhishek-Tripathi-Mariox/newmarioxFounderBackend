import { defineModel, text, dec, REQUIRED, PK } from '../modelKit.js';

/** Who works on each milestone, with their hours (composite key milestone_id + member_id). */
export const MilestoneMember = defineModel('milestone_members', {
  milestone_id: text(REQUIRED), // → milestones, CASCADE
  member_id: text(REQUIRED), // → members, CASCADE
  alloc_hours: dec(2, 0),
}, { pk: PK.hidden, stamps: false, indexes: [[{ milestone_id: 1, member_id: 1 }, { unique: true }], [{ member_id: 1 }]] });
