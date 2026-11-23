import { z } from 'zod';
import { TONES } from '../lib/pipeline.js';
import { R, zPhone, zs } from '../lib/validate.js';

export const pipelineSchema = z.object({
  stages: z.array(z.object({ key: z.string().optional(), name: z.string().min(1), prob: z.coerce.number().min(0).max(100) })).min(1),
  sources: z.array(z.string().min(1)).min(1),
  priorities: z.array(z.object({ name: z.string().min(1), tone: z.enum(TONES) })).min(1),
  lostReasons: z.array(z.string().min(1)).min(1),
});

export const settingsSchema = z.object({
  contacts: z
    .array(z.object({ title: zs(R.words(2, 60), true, 60), name: zs(R.person, true, 80), role: zs(R.words(2, 80), false, 80), phone: zPhone(true), email: zs(R.email, true, 254), note: zs(undefined, false, 300) }))
    .optional(),
  announcement: z.string().optional(),
  pipeline: pipelineSchema.optional(),
});
