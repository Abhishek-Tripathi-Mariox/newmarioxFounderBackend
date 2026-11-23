import { Member, SalesOwner, User } from '../../db/models/index.js';
import { TEXT_ORDER, ilike } from '../../db/modelKit.js';
import { tx } from '../../db/mongo.js';
import { notFound } from '../../core/errors.js';
import { ensureFounderOwners } from './founderOwners.js';

const memberDto = (m) => ({
  id: m.id, name: m.name, roleTitle: m.role_title, team: m.team, hue: m.hue, shiftHours: Number(m.shift_hours),
  costPerHour: m.cost_per_hour === null ? null : Number(m.cost_per_hour), active: m.active, userId: m.user_id || null,
});
/** `founder`: a Founder / Co-founder profile (owns leads; not sales staff on Live / attendance / reports). */
const ownerDto = (o) => ({ id: o.id, name: o.name, hue: o.hue, active: o.active, userId: o.user_id || null, founder: !!o.founder });

/** Attach `user_id` (the linked account, via users.<linkField>) to member / sales-owner rows. */
async function withUserIds(rows, linkField) {
  const users = await User.find({ [linkField]: { $in: rows.map((r) => r.id) } }).select(linkField).rows();
  const userOf = new Map(users.map((u) => [u[linkField], u.id]));
  return rows.map((r) => ({ ...r, user_id: userOf.get(r.id) || null }));
}

/** Delivery members for dropdowns / Team & hours (not paginated — the directory is small). */
export async function listMembers(f) {
  const filter = {};
  if (f.team) filter.team = f.team;
  if (f.active !== undefined) filter.active = f.active;
  if (f.q) filter.name = ilike(f.q);
  const rows = await Member.find(filter).sort({ name: 1 }).collation(TEXT_ORDER).rows();
  return (await withUserIds(rows, 'member_id')).map(memberDto);
}

export async function getMember(id) {
  const m = await Member.findOne({ id }).rows();
  if (!m) throw notFound('Member');
  const [row] = await withUserIds([m], 'member_id');
  return memberDto(row);
}

/** Shift length / hourly cost. The linked user's shift is kept in step. */
export async function updateMember(id, body) {
  await tx(async (session) => {
    const m = await Member.findOne({ id }).select('_id').session(session).rows();
    if (!m) throw notFound('Member');
    const patch = {};
    if (body.shiftHours !== undefined) patch.shift_hours = body.shiftHours;
    if (body.costPerHour !== undefined) patch.cost_per_hour = body.costPerHour;
    if (!Object.keys(patch).length) return;
    await Member.updateOne({ id }, patch, { session });
    if (patch.shift_hours !== undefined) await User.updateMany({ member_id: id }, { shift_hours: patch.shift_hours }, { session });
  });
  return getMember(id);
}

/** Sales owners for pickers (the founders' profiles are created here on first need). */
export async function listOwners(f) {
  await ensureFounderOwners();
  const filter = f.active !== undefined ? { active: f.active } : {};
  const rows = await SalesOwner.find(filter).sort({ name: 1 }).collation(TEXT_ORDER).rows();
  return (await withUserIds(rows, 'owner_id')).map(ownerDto);
}
