import { z } from 'zod';
import { R, zPhone, zs } from '../lib/validate.js';
import { ACQ_LIST_KEYS, HOME, MEETING_TYPES } from './acquisition.rules.js';

const str = z.string().trim().max(500).optional().default('');
const day = z.string().regex(/^\d{4}-\d\d-\d\d$/);
const temp = z.enum(['hot', 'warm', 'cold']);

export const meetSchema = z.object({
  date: day.optional(),
  time: zs(R.time, false, 5).default(''),
  link: zs(R.url, false, 500).default(''),
  attendees: z.array(z.string()).max(20).optional().default([]),
  duration: z.number().int().min(5).max(480).optional().default(30),
  type: z.string().trim().max(60).optional().default(MEETING_TYPES[0]),
  prep: z.array(z.string().max(60)).max(20).optional().default([]),
  agenda: z.string().trim().max(500).optional().default(''),
});

export const leadFields = z.object({
  name: zs(R.person, true, 80),
  company: zs(R.company, false, 120).default(''),
  source: str,
  channel: str,
  owner: str,
  contactedAt: day,
  phone: zPhone().default(''),
  email: zs(R.email, false, 254).default(''),
  // "linkedin.com/in/x" is accepted and saved as https://…
  linkedin: zs((v) => R.url(v && !/^https?:\/\//i.test(v) ? `https://${v}` : v), false, 300).default(''),
  notes: z.string().max(4000).optional().default(''),
  services: z.array(z.string()).max(30).optional().default([]),
  temp: temp.default('warm'),
  country: z.string().trim().max(60).optional().default(HOME),
  city: zs(R.city, false, 60).default(''),
});

/** With a meeting date the lead goes straight to Meeting; without one it is a Lead with a next step. */
export const createSchema = leadFields.extend({
  next: day.optional(),
  meet: meetSchema.optional(),
  force: z.boolean().optional(),
  today: day.optional(),
});

export const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), lead: leadFields, meet: meetSchema.optional(), today: day.optional() }),
  z.object({ action: z.literal('invited') }),
  z.object({ action: z.literal('onboard'), today: day.optional() }),
  z.object({ action: z.literal('temp'), temp }),
  z.object({ action: z.literal('notes'), notes: z.string().max(4000) }),
  z.object({ action: z.literal('reopen'), today: day.optional() }),
  z.object({
    action: z.literal('update'),
    opt: z.enum(['meet', 'later', 'reject', 'done', 'convert', 'move', 'again']),
    today: day.optional(),
    temp: temp.optional(),
    note: z.string().max(2000).optional().default(''),
    meet: meetSchema.optional(),
    why: z.enum(['missed', 'moved']).optional(),
    next: day.optional(),
    convertedAt: day.optional(),
    email: z.string().trim().optional(),
    commissionRate: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
  }),
]);

export const listsSchema = z.object(Object.fromEntries(ACQ_LIST_KEYS.map((k) => [k, z.array(z.string().trim().min(1).max(80)).min(1, 'Keep at least one').max(60)])));
export const emailsSchema = z.record(z.string().max(80), z.union([z.literal(''), z.string().trim().email('Team email looks wrong')]));
export const settingsSchema = z.object({ lists: listsSchema.optional(), emails: emailsSchema.optional() });

export const sampleSchema = z.object({ action: z.enum(['load', 'clear']), today: z.string().optional() });

const s500 = z.string().trim().max(500).optional().default('');
const dayOrEmpty = z.union([z.literal(''), z.string().regex(/^\d{4}-\d\d-\d\d$/)]).optional().default('');
const importRow = z.object({
  name: z.string().trim().min(1).max(120), company: s500, source: s500, channel: s500, owner: s500, email: s500, phone: s500,
  linkedin: s500, notes: s500, country: s500, city: s500, cdate: dayOrEmpty, mdate: dayOrEmpty, mtime: s500, mlink: s500,
});
export const importSchema = z.object({ rows: z.array(importRow).max(2000), today: z.string().optional() });
