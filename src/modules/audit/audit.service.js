import { AuditLog } from '../../db/models/index.js';
import { pageParams } from '../../core/http.js';

const toDto = (r) => ({ id: r.id, at: new Date(r.created_at).toISOString(), actor: r.actor_name, actorUserId: r.actor_user_id, text: r.text, kind: r.kind });

/** Users & roles → Activity log: newest first, optional kind filter. */
export async function list(f) {
  const p = pageParams(f);
  const filter = f.kind ? { kind: f.kind } : {};
  const [count, rows] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter).sort({ created_at: -1, _id: -1 }).skip(p.offset).limit(p.limit).rows(),
  ]);
  return { rows: rows.map(toDto), meta: p.meta(count) };
}
