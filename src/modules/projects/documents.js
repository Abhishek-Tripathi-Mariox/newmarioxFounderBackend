/**
 * Project / change-request file uploads, delegated to the shared documents module
 * (files were already streamed to storage — S3 — by middleware/upload.js).
 */
import { badRequest } from '../../core/errors.js';
import { Document } from '../../db/models/index.js';
import { documentsService, DOC_KINDS } from '../documents/documents.service.js';

/**
 * Record uploaded files against `entityType` ('project' | 'cr'). An explicit `kind` (one of the
 * document kinds) overrides the kind guessed from each file name. Returns document DTOs.
 * `session` keeps the position the knex `trx` had, so callers only swap the argument.
 */
export async function attachDocuments(entityType, entityId, files, user, session = null, kind = undefined) {
  if (!files || !files.length) throw badRequest('Attach at least one file (form field "files")');
  const docs = await documentsService.attach(entityType, entityId, files, user, session);
  if (kind && DOC_KINDS.includes(kind)) {
    await Document.updateMany({ _id: { $in: docs.map((d) => d.id) } }, { kind }, { session });
    return docs.map((d) => ({ ...d, kind }));
  }
  return docs;
}

export const discardUploads = (files) => documentsService.discard(files);

/** Delete an entity's document rows; returns a callback that removes the files (call after commit). */
export const removeDocuments = (entityType, entityId, session = null) => documentsService.removeForEntity(entityType, entityId, session);
