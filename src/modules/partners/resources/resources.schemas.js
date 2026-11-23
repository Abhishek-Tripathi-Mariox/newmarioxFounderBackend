import { z } from 'zod';
import { R, zs } from '../lib/validate.js';

/** A sales kit item (create; `partial()` for edits). A file or a link is chosen in the UI. */
export const resourceSchema = z.object({
  type: z.string().min(1),
  industry: zs(R.tags, false, 200),
  title: zs(R.title, true, 120),
  format: zs((v) => (!v || /^[A-Za-z0-9]{2,6}$/.test(v) ? null : 'Format is a short file type, e.g. PDF'), false, 6),
  size: zs((v) => (!v || /^\d+(\.\d+)?\s?(KB|MB|GB)$/i.test(v) ? null : 'Size looks like 4.2 MB'), false, 12),
  url: zs(R.url, false, 500),
  file: z.object({ fileId: z.string(), name: z.string(), size: z.number(), type: z.string() }).nullable().optional(),
  hidden: z.boolean().optional(),
});
export const resourcePatchSchema = resourceSchema.partial();
