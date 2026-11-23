import { AuditLog } from '../db/models/index.js';

/**
 * Append an entry to the admin activity log (Users & roles → Activity log).
 * kind: 'Invite' | 'Role' | 'Access' | 'Profile' | 'Credentials'. Pass the transaction's session when inside one.
 */
export async function audit(req, text, kind, session = null) {
  const actor = req.actor || req.user;
  await AuditLog.insertMany([{ actor_user_id: actor ? actor.id : null, actor_name: actor ? actor.name : 'System', text, kind }], { session });
}
