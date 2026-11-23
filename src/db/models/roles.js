import { defineModel, text, int, bool, json, REQUIRED } from '../modelKit.js';

/** Built-in role of Super Admins (sees and changes everything). */
export const SUPER_ROLE = 'r-super';
/** Built-in, locked role of Mariox Partners partners: the partner app only, never internal data (docs/SSO.md). */
export const PARTNER_ROLE = 'r-partner';

/** Roles and their permission matrix: perms = { [module]: { v, c, e, d, scope: 'all'|'team'|'own' } }. */
export const Role = defineModel('roles', {
  name: text(REQUIRED),
  description: text(''),
  hue: int(265),
  locked: bool(false),
  perms: json({}),
}, { indexes: [[{ name: 1 }, { unique: true }]] });
