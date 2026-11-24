/**
 * Founders HQ (CofounderMariox, MongoDB) → Mariox One.
 *   users              → portal `users` (the one account store, docs/SSO.md): the account with the same email
 *                        gets `hq_seat` = the original seat id ('rahul' / 'saswat' …, so workspace data stays
 *                        valid) and `hq_role`; without one, a new Super Admin account is created with the HQ
 *                        password hash. Plus the seat record in `hq_users` (same _id: authorship references).
 *   workspaces         → hq_workspaces (by key), workspacerevisions → hq_workspace_revisions (by version),
 *   vaults             → hq_vaults (by key): copied as they are (the vault is encrypted in the browser).
 */
import { ensureFounderOwner } from '../../src/modules/people/founderOwners.js';
import { HqUser, HqVault, HqWorkspace, HqWorkspaceRevision, User } from '../../src/db/models/index.js';
import { PARTNER_ROLE, SUPER_ROLE } from '../../src/db/models/roles.js';
import { HQ_ROLE_LABELS, LEGACY_HQ_SEATS, isHqSeatId } from '../../src/db/models/users.js';
import { isBcrypt, normEmail } from './accounts.js';
import { readAll, upsertDoc } from './docs.js';

/**
 * Founders own leads: give the seat holder their founder sales-owner profile (people/founderOwners.js),
 * keeping the account's migrated updated_at (so a re-run sees the account unchanged).
 */
async function linkFounderOwner(userId) {
  const before = await User.findOne({ id: userId }).select('updated_at owner_id').rows();
  await ensureFounderOwner(userId);
  if (before && !before.owner_id) await User.updateOne({ id: userId }, { $set: { updated_at: before.updated_at } }, { timestamps: false });
}

const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Source collection → [target model, key field]. */
const COPIED = [
  ['workspaces', HqWorkspace, 'key'],
  ['workspacerevisions', HqWorkspaceRevision, 'version'],
  ['vaults', HqVault, 'key'],
];
const KNOWN = new Set(['users', ...COPIED.map(([c]) => c)]);

/**
 * @param {{ db: import('mongodb').Db, report: import('./report.js').Report, dryRun: boolean, directory: import('./accounts.js').AccountDirectory, log?: Function }} ctx
 */
export async function migrateHq({ db, report, dryRun, directory, log = () => {} }) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  for (const n of names) if (!KNOWN.has(n) && !n.startsWith('system.')) report.warn('hq', n, 'collection is not known to Mariox One — not migrated');

  log('hq: users');
  const accounts = report.row('hq.users', 'users (accounts)');
  const seats = report.row('hq.users', 'hq_users');
  const users = (await readAll(db, 'users')).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const u of users) {
    accounts.read++;
    seats.read++;
    const seat = String(u.seat || '').toLowerCase();
    const email = normEmail(u.email);
    const where = 'hq.users';
    if (!isHqSeatId(seat)) {
      report.error(where, email, `seat "${u.seat}" is not a valid HQ person id — skipped`);
      accounts.skipped++;
      seats.skipped++;
      continue;
    }
    const hqRole = LEGACY_HQ_SEATS[seat] || 'cofounder';
    const portal = directory.findByEmail(email);
    const holder = directory.find((x) => x.hq_seat === seat);
    let userId = null;

    if (holder && (!portal || holder.id !== portal.id)) {
      report.error(where, email, `HQ seat "${seat}" is already held by target user ${holder.id} (${holder.email}) — account not linked; the seat record keeps pointing at ${holder.id}`);
      accounts.skipped++;
      userId = holder.id;
    } else if (portal) {
      if (portal.role_id === PARTNER_ROLE) {
        report.error(where, email, `the account ${portal.id} with this email is a Partner account — HQ access not given (partners never get internal access)`);
        accounts.skipped++;
      } else if (portal.hq_seat && portal.hq_seat !== seat) {
        report.error(where, email, `account ${portal.id} already holds HQ seat "${portal.hq_seat}" — not changed to "${seat}"`);
        accounts.skipped++;
        userId = null;
      } else {
        userId = portal.id;
        if (portal.hq_seat === seat && portal.hq_role) accounts.unchanged++;
        else {
          await directory.update(portal.id, { hq_seat: seat, hq_role: portal.hq_role || hqRole });
          accounts.updated++;
          report.info(where, email, `linked to existing account ${portal.id}; that account's password is kept (the old Founders HQ password is not used any more)`);
        }
        if (portal.role_id !== SUPER_ROLE) {
          report.warn(where, email, `linked to ${portal.id} whose role is ${portal.role_id}, not Super Admin (founders are Super Admins) — HQ access works; change the role in Users & roles if wanted`);
        }
      }
    } else {
      const hasHash = isBcrypt(u.passwordHash);
      const id = await directory.newUserId();
      await directory.create({
        id,
        name: String(u.name || email).trim().slice(0, 80),
        email,
        title: HQ_ROLE_LABELS[hqRole],
        role_id: SUPER_ROLE,
        dept: 'Management',
        join_date: dayOf(u.createdAt),
        status: hasHash ? 'Active' : 'Invited',
        password_hash: hasHash ? u.passwordHash : null,
        last_active_at: u.lastLoginAt ?? null,
        hq_seat: seat,
        hq_role: hqRole,
        created_at: u.createdAt ?? new Date(),
        updated_at: u.updatedAt ?? new Date(),
      });
      userId = id;
      accounts.inserted++;
      report.info(where, email, `new Super Admin account ${id} with HQ seat "${seat}"${hasHash ? ' (HQ password kept)' : ' — no usable password hash: status Invited, send an invite'}`);
    }
    if (userId && !dryRun && directory.byId.get(userId)?.hq_seat === seat) await linkFounderOwner(userId);

    // The seat record (hq_users), same _id: workspace `updatedBy` / revision `by` point at it.
    const record = {
      _id: u._id,
      name: String(u.name || '').trim().slice(0, 80) || email,
      email,
      seat,
      user_id: userId,
      prefs: u.prefs && typeof u.prefs === 'object' ? u.prefs : {},
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
    const clash = await HqUser.collection.findOne({ seat, _id: { $ne: u._id } });
    if (clash) {
      report.warn(where, email, `replaced the target's own seat record for "${seat}" (created on first use) with the migrated one`);
      if (!dryRun) await HqUser.collection.deleteOne({ _id: clash._id });
    }
    seats[await upsertDoc(HqUser.collection, record, { dryRun })]++;
  }

  for (const [name, model, key] of COPIED) {
    log(`hq: ${name}`);
    const row = report.row(`hq.${name}`, model.collection.collectionName);
    for (const doc of await readAll(db, name)) {
      row.read++;
      const { __v, ...clean } = doc; // eslint-disable-line no-unused-vars
      try {
        row[await upsertDoc(model.collection, clean, { filter: { [key]: doc[key] }, dryRun })]++;
      } catch (err) {
        report.error(`hq.${name}`, String(doc._id), err.code === 11000 ? 'duplicate key' : err.message);
        row.skipped++;
      }
    }
  }
}
