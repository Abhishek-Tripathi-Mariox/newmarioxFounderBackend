import { z } from 'zod';

import { MODS } from '../../core/permissions.js';

/**
 * Permission modules (src/core/permissions.js has the list, which actions each one has and which
 * have a data scope). `pp` = the old single Mariox Partners switch, still accepted in a patch: it
 * applies to every partner module (View → View, Edit → Create / Edit / Delete).
 */
export { MODS };
const PATCH_MODS = [...MODS, 'pp'];

export const roleIdParams = z.object({ id: z.string().regex(/^r-[a-z0-9-]{1,40}$/i, 'Invalid role id') });

const cell = z.object({
  v: z.boolean().optional(),
  c: z.boolean().optional(),
  e: z.boolean().optional(),
  d: z.boolean().optional(),
  scope: z.enum(['all', 'team', 'own']).optional(),
}).strict();

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
});

/** perms is a patch: only the modules / actions given change, then the frontend toggle rules apply. */
export const updateRoleSchema = z.object({
  name: z.string().trim().min(1, 'Enter a role name.').max(60).optional(),
  description: z.string().trim().max(200).optional(),
  hue: z.number().int().min(0).max(360).optional(),
  perms: z.partialRecord(z.enum(PATCH_MODS), cell).optional(),
});
