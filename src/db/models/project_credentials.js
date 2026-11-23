import { defineModel, text, int, REQUIRED, PK } from '../modelKit.js';

/** Credentials of a project integration (value encrypted by the API). Deleted with their integration. */
export const ProjectCredential = defineModel('project_credentials', {
  integration_id: int(REQUIRED), // → project_integrations, CASCADE
  label: text(REQUIRED), // e.g. "API key", "Secret", "Login email", "Password"
  env: text('Live'), // Test / Live / Both
  value_enc: text(REQUIRED),
  updated_by: text(), // → users, SET NULL
  position: int(0),
}, { pk: PK.serial, indexes: [[{ integration_id: 1 }]] });
