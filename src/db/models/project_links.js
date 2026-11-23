import { defineModel, text, REQUIRED, PK } from '../modelKit.js';

/** Project links (repo, staging, design …). Deleted with their project. */
export const ProjectLink = defineModel('project_links', {
  project_id: text(REQUIRED), // → projects, CASCADE
  type: text(REQUIRED),
  url: { type: String, required: true, match: /^https?:\/\//i },
}, { pk: PK.serial, stamps: false, indexes: [[{ project_id: 1 }]] });
