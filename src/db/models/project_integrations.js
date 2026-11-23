import { defineModel, text, REQUIRED, PK } from '../modelKit.js';

/** Third parties used on a project (payment gateway, SMS …). Deleted with their project. */
export const ProjectIntegration = defineModel('project_integrations', {
  project_id: text(REQUIRED), // → projects, CASCADE
  name: text(REQUIRED),
  category: text('Other'),
  status: text('Pending from client'),
  url: text(''), // dashboard / console link
  notes: text(''),
  created_by: text(), // → users, SET NULL
}, { pk: PK.serial, indexes: [[{ project_id: 1 }]] });
