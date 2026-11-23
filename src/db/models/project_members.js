import { defineModel, text, int, bool, dec, REQUIRED, PK } from '../modelKit.js';

/** Project team (composite key project_id + member_id). Deleted with their project. */
export const ProjectMember = defineModel('project_members', {
  project_id: text(REQUIRED), // → projects, CASCADE
  member_id: text(REQUIRED), // → members
  alloc_hours: dec(2, 0),
  position: int(0), // PM first, like the frontend team list
  is_primary: bool(false),
}, { pk: PK.hidden, stamps: false, indexes: [[{ project_id: 1, member_id: 1 }, { unique: true }], [{ member_id: 1 }]] });
