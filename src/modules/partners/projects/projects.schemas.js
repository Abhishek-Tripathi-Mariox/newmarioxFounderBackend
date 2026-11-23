import { z } from 'zod';
import { R, zMoney, zPhone, zs } from '../lib/validate.js';

const day = zs(R.date, false, 10);

export const paymentSchema = z.object({
  _id: z.string().optional(),
  label: zs(R.words(2, 80), true, 80),
  amount: zMoney('Milestone amount'),
  due: day,
  status: z.enum(['upcoming', 'due', 'received']).default('upcoming'),
  releasedAt: day,
  utr: zs((v) => (!v || /^[A-Za-z0-9]{6,30}$/.test(v) ? null : 'UTR is 6–30 letters or digits'), false, 30),
});

/** A partner project (create; `partial()` for edits). */
export const projectSchema = z.object({
  owner: z.string().min(1),
  lead: z.string().optional(),
  client: zs(R.company, true, 120),
  contact: zPhone(),
  city: zs(R.city, false, 60),
  title: zs(R.title, true, 120),
  deal: zMoney('Deal value').optional(),
  commissionRate: z.coerce.number().min(0).max(1).optional(),
  closedAt: day,
  stage: z.number().int().min(0).max(4).optional(),
  pm: zs(R.person, false, 80),
  update: zs(R.words(3), false, 2000),
  milestones: z.array(z.string()).optional(),
  payments: z.array(paymentSchema).optional(),
});

export const projectPatchSchema = projectSchema.partial();
