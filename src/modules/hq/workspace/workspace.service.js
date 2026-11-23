import { logger } from '../../../core/logger.js';
import { HqUser } from '../../../db/models/hq_users.js';
import { HqWorkspace } from '../../../db/models/hq_workspaces.js';
import { HqWorkspaceRevision } from '../../../db/models/hq_workspace_revisions.js';
import { conflict } from '../core/errors.js';

const WORKSPACE_KEY = 'main';
export const REVISIONS_KEPT = 200;

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/** `{ id, name }` for a populated (or missing) user reference. */
const toAuthor = (user) => (user ? { id: String(user._id), name: user.name } : null);

function toSnapshot(doc) {
  if (!doc) return { data: null, version: 0, updatedAt: null, updatedBy: null };
  return { data: doc.data ?? null, version: doc.version, updatedAt: toIso(doc.updatedAt), updatedBy: toAuthor(doc.updatedBy) };
}

const loadWorkspace = () => HqWorkspace.findOne({ key: WORKSPACE_KEY }).populate('updatedBy', 'name').lean();

/** The shared workspace, or an empty snapshot (version 0) before the first save. */
export async function getWorkspace() {
  return toSnapshot(await loadWorkspace());
}

/**
 * Save the workspace if nobody else saved since `baseVersion`.
 *
 * The version check and the write are one atomic `findOneAndUpdate`, so two founders saving at the
 * same moment can never overwrite each other: exactly one wins, the other gets 409 with the newer
 * copy in `details` to merge or reload.
 *
 * @param {{ data: object, baseVersion: number, user: { _id: unknown, name: string } }} input
 */
export async function saveWorkspace({ data, baseVersion, user }) {
  let saved = null;
  try {
    saved = await HqWorkspace.findOneAndUpdate(
      { key: WORKSPACE_KEY, version: baseVersion },
      { $set: { data, updatedBy: user._id }, $inc: { version: 1 } },
      // Only the very first save (baseVersion 0) may create the document.
      { new: true, upsert: baseVersion === 0, lean: true },
    );
  } catch (error) {
    // A concurrent first save created the document first: treat as a normal conflict.
    if (error?.code !== 11000) throw error;
  }

  if (!saved) {
    const current = toSnapshot(await loadWorkspace());
    throw conflict('The workspace changed since you last loaded it. Review the newer version before saving again.', current);
  }

  await recordRevision(saved.version, user._id, saved.updatedAt);
  return { version: saved.version, updatedAt: toIso(saved.updatedAt), updatedBy: toAuthor(user) };
}

/**
 * Store an audit entry and trim history to the newest REVISIONS_KEPT. The workspace itself is already
 * saved at this point, so a failure here is logged rather than reported to the client.
 */
async function recordRevision(version, userId, at) {
  try {
    await HqWorkspaceRevision.create({ version, by: userId, at });
    const oldestKept = await HqWorkspaceRevision.findOne().sort({ version: -1 }).skip(REVISIONS_KEPT - 1).select('version').lean();
    if (oldestKept) await HqWorkspaceRevision.deleteMany({ version: { $lt: oldestKept.version } });
  } catch (error) {
    logger.warn({ err: error, version }, 'Could not record HQ workspace revision');
  }
}

/** This user's own UI preferences (`{}` until they save some). */
export async function getPrefs(userId) {
  const user = await HqUser.findById(userId).select('+prefs').lean();
  return user?.prefs ?? {};
}

/** Replace this user's UI preferences. */
export async function savePrefs(userId, prefs) {
  const user = await HqUser.findByIdAndUpdate(userId, { $set: { prefs } }, { new: true }).select('+prefs').lean();
  return user?.prefs ?? {};
}
