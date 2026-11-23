import { z } from 'zod';
import { R, notPast, zMoney, zPhone, zs } from '../lib/validate.js';

const day = zs(R.date, false, 10);

/** A partner lead (create; `partial()` for edits). `owner` is honoured for admins only. */
export const leadSchema = z.object({
  company: zs(R.company, true, 120),
  project: zs(R.words(2, 120), false, 120),
  value: zMoney('Estimated value').optional(),
  contact: zs(R.person, false, 80),
  phone: zPhone(),
  email: zs(R.email, false, 254),
  city: zs(R.city, false, 60),
  source: zs(undefined, false, 60),
  priority: zs(undefined, false, 40),
  stage: z.string().min(1).optional(), // checked against the pipeline config in the service
  lostReason: zs(undefined, false, 120),
  expectedClose: day,
  owner: z.string().optional(),
});

/** Lead edits, plus tasks and activities through the same PATCH (as the source). */
export const leadPatchSchema = leadSchema.partial().extend({
  addActivity: z.object({ type: z.enum(['call', 'meeting', 'email', 'note']), text: zs(R.words(3, 1000), true, 1000) }).optional(),
  addTask: z.object({ text: zs(R.words(2, 200), true, 200), due: zs((v) => notPast(v, 'Due date'), false, 10) }).optional(),
  toggleTask: z.string().optional(),
  removeTask: z.string().optional(),
});
