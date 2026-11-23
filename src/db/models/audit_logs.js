import { defineModel, text, oneOf, REQUIRED, PK } from '../modelKit.js';

/** Admin activity log (Users & roles → Activity log). */
export const AUDIT_KINDS = ['Invite', 'Role', 'Access', 'Profile', 'Credentials'];

export const AuditLog = defineModel('audit_logs', {
  actor_user_id: text(), // → users, SET NULL
  actor_name: text(REQUIRED),
  text: text(REQUIRED),
  kind: oneOf(AUDIT_KINDS, REQUIRED),
}, { pk: PK.serial, stamps: 'created', indexes: [[{ created_at: -1 }]] });
