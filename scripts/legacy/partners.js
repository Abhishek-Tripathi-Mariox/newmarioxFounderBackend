/**
 * Mariox Partners (mariox-saas, MongoDB) → Mariox One `pp_*` collections, same `_id`s (every ObjectId
 * reference — owner, lead, partner, fileId — stays valid). Documents are copied as they are; fields the
 * Mariox One models don't have are dropped and reported.
 *
 * Accounts (docs/SSO.md): the portal `users` collection is the only account store.
 *   - partner  → `pp_users` profile + a portal user (role Partner `r-partner`, `pp_user_id` link) holding the
 *                partner's bcrypt password hash (both apps use bcryptjs); an active partner without a usable
 *                hash becomes Invited. Pending invites keep working (same sha256 token hash on the profile).
 *   - admin    → `pp_users` admin profile, linked (`pp_user_id`) to the portal user with the same email.
 */
import { PP_MODULES } from '../../src/core/permissions.js';
import * as M from '../../src/db/models/index.js';
import { PARTNER_ROLE, SUPER_ROLE } from '../../src/db/models/roles.js';
import { isBcrypt, normEmail } from './accounts.js';
import { invalidReason, knownFields, readAll, upsertDoc } from './docs.js';

/** mariox-saas collection → Mariox One model. */
export const PARTNER_COLLECTIONS = [
  ['acqleads', M.PpAcqLead],
  ['leads', M.PpLead],
  ['projects', M.PpProject],
  ['scopes', M.PpScope],
  ['bookings', M.PpBooking],
  ['techrequests', M.PpTechRequest],
  ['tickets', M.PpTicket],
  ['files', M.PpFile],
  ['resources', M.PpResource],
  ['settings', M.PpSetting],
];

/** Not migrated: GridFS buckets of an earlier file-storage version (the app reads files from S3 via `files`). */
const SKIPPED = { 'uploads.files': 'GridFS (old file storage, not used by the app)', 'uploads.chunks': 'GridFS (old file storage, not used by the app)' };

/** Profile fields that are not copied: the password lives on the portal user; reset codes are ephemeral. */
const PROFILE_DROPPED = ['passwordHash', 'sessionVersion', 'resetOtpHash', 'resetOtpExpires', 'resetOtpSentAt', 'resetOtpAttempts', 'resetTokenHash', 'resetTokenExpires'];

const PORTAL_STATUS = { invited: 'Invited', active: 'Active', disabled: 'Deactivated' };

/** Can a role open the partner admin (core/permissions.js canPartnerAdmin)? */
const rolePartnerAdmin = (roleId, perms) => roleId === SUPER_ROLE || PP_MODULES.some((m) => perms?.[m]?.v) || (!!perms?.pp?.v && !PP_MODULES.some((m) => perms?.[m]));

/** Drop top-level fields the model doesn't know; returns the names dropped. */
function strip(model, doc, extra = []) {
  const known = knownFields(model);
  const dropped = [];
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (extra.includes(k)) continue;
    if (!known.has(k)) dropped.push(k);
    else out[k] = v;
  }
  return { doc: out, dropped };
}

/**
 * @param {{ db: import('mongodb').Db, report: import('./report.js').Report, dryRun: boolean, directory: import('./accounts.js').AccountDirectory, log?: Function }} ctx
 */
export async function migratePartners({ db, report, dryRun, directory, log = () => {} }) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  const known = new Set(['users', ...PARTNER_COLLECTIONS.map(([c]) => c), ...Object.keys(SKIPPED)]);
  for (const n of names) if (!known.has(n) && !n.startsWith('system.')) report.warn('partners', n, 'collection is not known to Mariox One — not migrated');
  for (const [n, why] of Object.entries(SKIPPED)) {
    if (names.includes(n)) report.skipTable(`partners.${n}`, await db.collection(n).countDocuments(), why);
  }

  const rolePerms = new Map((await M.Role.find({}).select('perms').rows()).map((r) => [r.id, r.perms]));
  for (const [id, perms] of directory.rolePerms) rolePerms.set(id, perms); // just migrated (dry run: not in the target yet)

  // ---- profiles + accounts
  log('partners: users');
  const profiles = report.row('partners.users', 'pp_users');
  const accounts = report.row('partners.users', 'users (accounts)');
  const migratedProfiles = new Set();
  const droppedFields = new Set();
  for (const src of await readAll(db, 'users')) {
    profiles.read++;
    accounts.read++;
    const id = String(src._id);
    const email = normEmail(src.email);
    const where = 'partners.users';
    const { doc, dropped } = strip(M.PpUser, { ...src, email }, PROFILE_DROPPED);
    dropped.forEach((d) => droppedFields.add(d));

    const isPartner = (src.role || 'partner') === 'partner';
    const hasHash = isBcrypt(src.passwordHash);
    if (isPartner && src.status === 'active' && !hasHash) {
      doc.status = 'invited';
      report.warn(where, email, 'active partner without a usable bcrypt password hash — set to Invited: send them a new invite from Partners admin');
    }

    const reason = invalidReason(M.PpUser, doc);
    if (reason) {
      report.error(where, id, `${reason} — skipped`);
      profiles.skipped++;
      accounts.skipped++;
      continue;
    }
    const clash = await M.PpUser.collection.findOne({ email, _id: { $ne: src._id } });
    if (clash) {
      report.error(where, id, `the target already has another Mariox Partners profile (${clash._id}, ${clash.role}) with ${email} — skipped; remove or rename one of them and re-run`);
      profiles.skipped++;
      accounts.skipped++;
      continue;
    }
    try {
      profiles[await upsertDoc(M.PpUser.collection, doc, { dryRun })]++;
      migratedProfiles.add(id);
    } catch (err) {
      report.error(where, id, err.code === 11000 ? `duplicate key ${JSON.stringify(err.keyValue || {})} — skipped` : err.message);
      profiles.skipped++;
      accounts.skipped++;
      continue;
    }

    if (isPartner) await linkPartner({ src, doc, id, email, hasHash, report, directory, accounts });
    else if (await linkAdmin({ id, email, directory, accounts, report })) checkAdminRole({ email, report, directory, rolePerms });
  }
  for (const f of droppedFields) report.warn('partners.users', null, `field "${f}" has no place in pp_users — dropped`);

  // ---- everything else, same _id
  for (const [name, model] of PARTNER_COLLECTIONS) {
    const target = model.collection.collectionName;
    log(`partners: ${name} → ${target}`);
    const row = report.row(`partners.${name}`, target);
    const dropped = new Set();
    const filesWithKeys = [];
    const ownsByProfile = model.schema.path('owner')?.instance === 'ObjectId';
    for (const src of await readAll(db, name)) {
      row.read++;
      const { doc, dropped: d } = strip(model, src);
      d.forEach((x) => dropped.add(x));
      const reason = invalidReason(model, doc);
      if (reason) {
        report.error(`partners.${name}`, String(src._id), `${reason} — skipped`);
        row.skipped++;
        continue;
      }
      if (ownsByProfile && doc.owner && !migratedProfiles.has(String(doc.owner)) && !(await M.PpUser.exists({ _id: doc.owner }))) {
        report.warn(`partners.${name}`, String(src._id), `owner ${doc.owner} is not a migrated Mariox Partners profile`);
      }
      try {
        const filter = name === 'settings' ? { key: doc.key ?? 'portal' } : { _id: doc._id };
        row[await upsertDoc(model.collection, doc, { filter, dryRun })]++;
        if (name === 'files') filesWithKeys.push(doc.key);
      } catch (err) {
        report.error(`partners.${name}`, String(src._id), err.code === 11000 ? `duplicate key ${JSON.stringify(err.keyValue || {})} — skipped` : err.message);
        row.skipped++;
      }
    }
    for (const f of dropped) report.warn(`partners.${name}`, null, `field "${f}" has no place in ${target} — dropped`);
    if (filesWithKeys.length) {
      report.info('partners.files', null, `${filesWithKeys.length} file record(s) keep their S3 object keys (uploads/…): copy the objects from the partner portal's bucket into S3_BUCKET (docs/MIGRATION.md "Files")`);
    }
  }
}

/** Partner profile ↔ portal user (role Partner). */
async function linkPartner({ src, doc, id, email, hasHash, report, directory, accounts }) {
  const where = 'partners.users';
  const status = PORTAL_STATUS[doc.status] || 'Invited';
  const fields = {
    name: String(doc.name || email).trim(),
    phone: doc.phone || '',
    status,
    password_hash: hasHash ? src.passwordHash : null,
    pp_user_id: id,
    last_active_at: src.lastLoginAt ?? null,
  };
  let user = directory.find((u) => u.pp_user_id === id);
  if (!user) {
    const byEmail = directory.findByEmail(email);
    if (byEmail) {
      if (byEmail.role_id !== PARTNER_ROLE || (byEmail.pp_user_id && byEmail.pp_user_id !== id)) {
        report.error(where, email, `this email already belongs to Mariox One account ${byEmail.id} (role ${byEmail.role_id}) — the partner profile ${id} is migrated but has NO login; one account can't be staff and partner: change the partner's email (Partners admin) or remove that account, then re-run`);
        accounts.skipped++;
        return;
      }
      user = byEmail;
    }
  }
  if (user) {
    const changed = Object.entries(fields).some(([k, v]) => {
      const cur = user[k];
      const isDate = (x) => Object.prototype.toString.call(x) === '[object Date]';
      return isDate(cur) || isDate(v) ? String(cur?.valueOf?.()) !== String(v?.valueOf?.()) : (cur ?? null) !== (v ?? null);
    });
    if (!changed && user.role_id === PARTNER_ROLE && normEmail(user.email) === email) {
      accounts.unchanged++;
      return;
    }
    await directory.update(user.id, { ...fields, email, role_id: PARTNER_ROLE });
    accounts.updated++;
    return;
  }
  const newId = await directory.newUserId();
  await directory.create({
    id: newId,
    email,
    title: 'Partner',
    role_id: PARTNER_ROLE,
    invited_at: src.createdAt ?? new Date(),
    created_at: src.createdAt ?? new Date(),
    updated_at: src.updatedAt ?? new Date(),
    ...fields,
  });
  accounts.inserted++;
}

/** Report admins who would not be able to open the partner admin with their role. */
function checkAdminRole({ email, report, directory, rolePerms }) {
  const user = directory.findByEmail(email);
  if (!rolePartnerAdmin(user.role_id, rolePerms.get(user.role_id))) {
    report.warn('partners.users', email, `partner admin linked to ${user.id}, whose role ${user.role_id} has no Partners (pp_*) permission — give the role Partners access in Users & roles (or make them Super Admin), otherwise they can't open Partners admin`);
  }
}

/** Admin profile ↔ portal user with the same email (`pp_user_id`). @returns {Promise<boolean>} linked */
async function linkAdmin({ id, email, directory, accounts, report }) {
  const where = 'partners.users';
  const user = directory.findByEmail(email);
  if (!user) {
    report.info(where, email, `partner admin profile ${id} migrated; there is no Mariox One account with this email — Super Admins and roles with Partners permissions run Mariox Partners (the profile is linked automatically if an account with this email opens Partners admin)`);
    accounts.skipped++;
    return false;
  }
  if (user.role_id === PARTNER_ROLE) {
    report.error(where, email, `partner admin profile ${id}: the account ${user.id} with this email is a Partner account — not linked`);
    accounts.skipped++;
    return false;
  }
  if (user.pp_user_id === id) {
    accounts.unchanged++;
    return true;
  }
  if (user.pp_user_id) {
    report.error(where, email, `account ${user.id} is already linked to Mariox Partners profile ${user.pp_user_id} — not relinked to ${id}`);
    accounts.skipped++;
    return false;
  }
  await directory.update(user.id, { pp_user_id: id });
  accounts.updated++;
  return true;
}
