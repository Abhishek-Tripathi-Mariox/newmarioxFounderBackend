/**
 * The one account store (docs/SSO.md): portal `users`. While the partner and Founders HQ sources are
 * migrated, every decision ("link to this user", "create a user") is made against this in-memory
 * directory of the target's users plus the users the migration has written (or, in a dry run, would
 * write), so a dry run reports exactly what a real run does.
 */
import { nextId } from '../../src/core/ids.js';
import { CASE_INSENSITIVE } from '../../src/db/modelKit.js';
import { User } from '../../src/db/models/index.js';

/** bcrypt hash ($2a$ / $2b$ / $2y$, any cost): what bcryptjs in Mariox One verifies. */
export const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
export const isBcrypt = (h) => typeof h === 'string' && BCRYPT_RE.test(h);

export const normEmail = (e) => String(e || '').trim().toLowerCase();

const FIELDS = 'name email phone role_id status password_hash last_active_at hq_seat hq_role pp_user_id owner_id';

export class AccountDirectory {
  constructor({ dryRun }) {
    this.dryRun = dryRun;
    /** id → user (subset of fields) */
    this.byId = new Map();
    /** role id → perms of the roles the portal phase migrated (dry run: not in the target yet) */
    this.rolePerms = new Map();
    this.planned = 0;
  }

  /** Load (or reload) every target user. */
  async load() {
    this.byId.clear();
    for (const u of await User.find({}).select(FIELDS).rows()) this.byId.set(u.id, u);
    return this;
  }

  /** Users written / planned by the portal phase (dry run: they are not in the target yet). */
  upsert(user) {
    this.byId.set(user.id, { ...(this.byId.get(user.id) || {}), ...user });
  }

  findByEmail(email) {
    const e = normEmail(email);
    for (const u of this.byId.values()) if (normEmail(u.email) === e) return u;
    return null;
  }

  find(pred) {
    for (const u of this.byId.values()) if (pred(u)) return u;
    return null;
  }

  /**
   * A fresh user id from the user counter (the counter has been advanced past every migrated id).
   * Dry run: a placeholder, nothing is reserved.
   */
  async newUserId() {
    if (this.dryRun) return `(new user ${++this.planned})`;
    for (;;) {
      const id = await nextId('user');
      if (!this.byId.has(id) && !(await User.exists({ _id: id }))) return id;
    }
  }

  /** Insert a user (real run) and remember it. */
  async create(row) {
    if (!this.dryRun) {
      if (await User.exists({ email: row.email }).collation(CASE_INSENSITIVE)) throw new Error(`a user with ${row.email} already exists`);
      await User.collection.insertOne(castUser(row));
    }
    this.upsert(row);
    return row;
  }

  /** Update a user (real run) and remember the change. */
  async update(id, set) {
    if (!this.dryRun) await User.updateOne({ id }, { $set: set }, { timestamps: false });
    this.upsert({ id, ...set });
  }
}

/**
 * A complete, validated users document (defaults filled, `_id` = id) ready for a raw insert that keeps
 * the given created_at / updated_at.
 */
export function castUser(row) {
  const { id, ...rest } = row;
  const now = new Date();
  const doc = new User({ _id: id, created_at: now, updated_at: now, ...rest });
  const err = doc.validateSync();
  if (err) throw new Error(`invalid user ${id}: ${Object.keys(err.errors).join(', ')}`);
  return doc.toObject();
}
