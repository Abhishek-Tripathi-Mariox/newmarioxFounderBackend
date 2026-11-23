import { defineModel, text, oneOf, int, REQUIRED, PK } from '../modelKit.js';

/** Uploaded files (object key in storage_path) attached to a lead, project, bug, change request or team task. */
export const DOCUMENT_ENTITIES = ['lead', 'project', 'bug', 'cr', 'team_task'];

export const Document = defineModel('documents', {
  entity_type: oneOf(DOCUMENT_ENTITIES, REQUIRED),
  entity_id: text(REQUIRED),
  name: text(REQUIRED),
  size: int(REQUIRED),
  mime: text(''),
  kind: text('Other'), // SOW, FRD, NDA, Proposal …
  storage_path: text(REQUIRED),
  uploaded_by: text(), // → users, SET NULL
  title: { ...text(), maxlength: 200 },
}, { pk: PK.uuid, stamps: 'created', indexes: [[{ entity_type: 1, entity_id: 1 }]] });
