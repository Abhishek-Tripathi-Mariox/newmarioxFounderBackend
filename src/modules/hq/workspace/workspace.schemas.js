import { z } from 'zod';

const MAX_PREFS_BYTES = 64 * 1024;

const plainObject = (label) => z.record(z.string(), z.unknown(), { error: `${label} must be an object.` });

export const saveWorkspaceBody = z.object({
  data: plainObject('Workspace data'),
  baseVersion: z
    .number({ error: 'baseVersion must be a whole number.' })
    .int({ error: 'baseVersion must be a whole number.' })
    .min(0, { error: 'baseVersion cannot be negative.' }),
});

export const savePrefsBody = z.object({
  prefs: plainObject('Preferences').refine((prefs) => JSON.stringify(prefs).length <= MAX_PREFS_BYTES, {
    error: 'Preferences are too large (64 KB max).',
  }),
});
