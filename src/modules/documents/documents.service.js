/**
 * Documents (files attached to leads, projects, bugs and change requests).
 * File bytes live in object storage (S3 in production — see core/storage), written by the
 * streaming `upload` middleware; the `documents` table stores metadata + the object key
 * (column `storage_path`). Buckets stay private: every download goes through checkAccess().
 *
 * Other modules attach files with:
 *   import { documentsService } from '../documents/documents.service.js';
 *   const docs = await documentsService.attach('project', projectId, req.files, req.user, session);
 */
import { Bug, ChangeRequest, Document, Lead } from '../../db/models/index.js';
import { forbidden, notFound } from '../../core/errors.js';
import { storage, downloadMode } from '../../core/storage/index.js';
import { logger } from '../../core/logger.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { can } from '../../middleware/authorize.js';
import { TEXT_ORDER } from '../../db/modelKit.js';

export const DOC_KINDS = ['SOW', 'FRD', 'BRD', 'NDA', 'Proposal', 'Contract / MSA', 'Wireframes', 'Invoice', 'Design specs', 'Other'];
export const ENTITY_TYPES = ['lead', 'project', 'bug', 'cr', 'team_task'];

/** Guess the document kind from a file name (port of frontend domain/files.docKind). */
export function docKind(name) {
  const n = ` ${(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return /\bsow\b|statement.of.work/.test(n) ? 'SOW'
    : /\bfrd\b|functional/.test(n) ? 'FRD'
      : /\bbrd\b|business.req/.test(n) ? 'BRD'
        : /\bnda\b|non.disclosure/.test(n) ? 'NDA'
          : /proposal|quotation|quote|estimate/.test(n) ? 'Proposal'
            : /contract|agreement|\bmsa\b/.test(n) ? 'Contract / MSA'
              : /wireframe/.test(n) ? 'Wireframes'
                : /invoice/.test(n) ? 'Invoice'
                  : /spec|style.?guide|design/.test(n) ? 'Design specs'
                    : 'Other';
}


export const toDocument = (r) => ({
  id: r.id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  name: r.name,
  title: r.title || '',
  size: Number(r.size),
  mime: r.mime,
  kind: r.kind,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  url: `/api/v1/documents/${r.id}/download`,
});

/**
 * Best-effort removal of stored objects. A failure only leaves an orphaned object behind (logged),
 * never a broken record, so it must not fail the request.
 */
async function removeObjects(keys) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return;
  try {
    await storage.remove(list);
  } catch (err) {
    logger.warn({ err, keys: list }, 'Could not delete stored files');
  }
}

/** Delete freshly uploaded files (call when the request fails after the upload middleware ran). */
const discard = (files) => removeObjects((files || []).map((f) => f.key));

/**
 * Record uploaded files against an entity.
 * @param {'lead'|'project'|'bug'|'cr'} entityType
 * @param {string} entityId
 * @param {Array<{originalname:string,size:number,mimetype:string,key:string}>} files uploaded files (req.files)
 * @param {{id:string}} user principal (uploaded_by)
 * @param {import('mongoose').ClientSession|null} [session] transaction session (the position the knex `trx` had)
 * @param {{title?:string}} [opts] optional title stored on every file of this upload
 * @returns {Promise<object[]>} document DTOs
 * The caller checks permissions on the entity first. On failure, call documentsService.discard(files).
 */
async function attach(entityType, entityId, files, user, session = null, opts = {}) {
  const title = String(opts.title || '').trim().slice(0, 200) || null;
  if (!files || !files.length) return [];
  const rows = files.map((f) => ({
    entity_type: entityType,
    entity_id: entityId,
    name: String(f.originalname || 'file').slice(0, 255),
    size: f.size,
    mime: String(f.mimetype || '').slice(0, 100),
    kind: docKind(f.originalname),
    storage_path: f.key,
    uploaded_by: user ? user.id : null,
    title,
  }));
  const inserted = await Document.insertRows(rows, session);
  return inserted.map(toDocument);
}

/** Documents of one entity, oldest first. */
async function listFor(entityType, entityId, session = null) {
  const rows = await Document.find({ entity_type: entityType, entity_id: entityId }).sort({ created_at: 1, name: 1 }).collation(TEXT_ORDER).session(session).rows();
  return rows.map(toDocument);
}

/** Documents of many entities in one query → { entityId: DTO[] } (every id present, oldest first). */
async function listForMany(entityType, entityIds, session = null) {
  const out = Object.fromEntries(entityIds.map((id) => [id, []]));
  if (!entityIds.length) return out;
  const rows = await Document.find({ entity_type: entityType, entity_id: { $in: entityIds } }).sort({ created_at: 1, name: 1 }).collation(TEXT_ORDER).session(session).rows();
  for (const r of rows) (out[r.entity_id] ||= []).push(toDocument(r));
  return out;
}

/**
 * Remove all document rows of an entity; returns a function that deletes the files (call it after
 * commit). Used when the parent entity is deleted.
 */
async function removeForEntity(entityType, entityId, session = null) {
  const filter = { entity_type: entityType, entity_id: entityId };
  const rows = await Document.find(filter).select('storage_path').session(session).rows();
  if (rows.length) await Document.deleteMany({ _id: { $in: rows.map((r) => r.id) } }, { session });
  return () => removeObjects(rows.map((r) => r.storage_path));
}

/** Move documents from one entity to another (lead merge). */
const reassign = (entityType, fromId, toId, session = null) => Document.updateMany({ entity_type: entityType, entity_id: fromId }, { entity_id: toId }, { session });

/**
 * Permission check through the parent entity. act 'v' for download, 'e' for kind change / delete.
 * Reads outside the user's scope → 404; writes outside scope → 403.
 */
async function checkAccess(doc, user, act) {
  const outside = () => { throw act === 'v' ? notFound('Document') : forbidden(); };
  const projectVisible = async (projectId) => {
    const ids = await visibleProjectIds(user);
    if (ids && !ids.includes(projectId)) outside();
  };
  const need = (mod) => { if (!can(user, mod, act)) throw forbidden(); };

  switch (doc.entity_type) {
    case 'lead': {
      need('leads');
      const lead = await Lead.findOne({ id: doc.entity_id }).select('owner_id').rows();
      if (!lead) throw notFound('Document');
      const { people } = await peopleScope(user, 'leads');
      if (people && !people.includes(lead.owner_id)) outside();
      return;
    }
    case 'project':
      need('projects');
      return projectVisible(doc.entity_id);
    case 'bug': {
      need('bugs');
      const bug = await Bug.findOne({ id: doc.entity_id }).select('project_id').rows();
      if (!bug) throw notFound('Document');
      return projectVisible(bug.project_id);
    }
    case 'cr': {
      need('projects');
      const cr = await ChangeRequest.findOne({ id: doc.entity_id }).select('project_id').rows();
      if (!cr) throw notFound('Document');
      return projectVisible(cr.project_id);
    }
    case 'team_task': {
      // Loaded lazily: team-tasks imports this module too.
      const { taskAccess } = await import('../team-tasks/teamTasks.service.js');
      const a = await taskAccess(doc.entity_id, user);
      if (!a) throw notFound('Document');
      // Changing / removing a file: the task's managers, or the assignee for files they added themselves.
      const own = a.canUpdateStatus && doc.uploaded_by === user.id;
      if (act !== 'v' && !a.canEdit && !own) throw forbidden('You can only remove files you added — the person who gave this task (or their manager) can remove the rest.');
      return;
    }
    default:
      throw notFound('Document');
  }
}

async function loadDoc(id) {
  const doc = await Document.findOne({ id }).rows();
  if (!doc) throw notFound('Document');
  return doc;
}

/**
 * Resolve a document for download after the permission check:
 *   { doc, mime, redirect }            — S3 "redirect" mode: short-lived presigned URL
 *   { doc, mime, stream, length }      — "proxy" mode (default): stream through the API
 */
async function download(id, user) {
  const doc = await loadDoc(id);
  await checkAccess(doc, user, 'v');
  // Never let a stored file render as active content in the browser.
  const risky = /html|xml|svg|javascript/i.test(doc.mime);
  const mime = !doc.mime || risky ? 'application/octet-stream' : doc.mime;
  if (downloadMode === 'redirect') {
    return { doc, mime, redirect: await storage.presign(doc.storage_path, { filename: doc.name, contentType: mime }) };
  }
  const obj = await storage.get(doc.storage_path);
  if (!obj) throw notFound('File');
  return { doc, mime, stream: obj.stream, length: obj.length };
}

async function setKind(id, kind, user) {
  const doc = await loadDoc(id);
  await checkAccess(doc, user, 'e');
  const row = await Document.findOneAndUpdate({ id }, { kind }, { new: true }).rows();
  return toDocument(row);
}

async function remove(id, user) {
  const doc = await loadDoc(id);
  await checkAccess(doc, user, 'e');
  await Document.deleteOne({ id });
  if (doc.entity_type === 'team_task') {
    const { logEvent } = await import('../team-tasks/teamTasks.service.js');
    await logEvent(doc.entity_id, user, 'detach', { meta: { files: [{ id: doc.id, name: doc.name }] }, text: doc.title || null });
  }
  await removeObjects([doc.storage_path]);
}

export const documentsService = { attach, discard, removeObjects, listFor, listForMany, removeForEntity, reassign, checkAccess, download, setKind, remove, docKind };
