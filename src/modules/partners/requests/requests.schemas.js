import { z } from 'zod';
import { R, slotError, zMoney, zs } from '../lib/validate.js';

const str = z.string().optional();
const day = zs(R.date, false, 10);
const attachment = z.object({ fileId: z.string(), name: z.string(), size: z.number(), type: z.string() });

/** What a partner may send when creating each request kind. */
export const requestCreate = {
  scope: z.object({
    client: zs(R.company, true, 120),
    project: zs(R.title, true, 120),
    needs: zs(R.words(5), false, 4000),
    lines: z.array(z.object({ name: zs(R.words(2, 120), true, 120), amount: zMoney('Line amount') })).max(50).default([]),
    // From POST /uploads; the service checks each file belongs to the submitter.
    attachments: z.array(attachment).max(10).default([]),
  }),
  // A visit or expert call can't be booked for a time that has already gone by (IST).
  booking: z.object({
    client: zs(R.company, true, 120),
    office: str,
    date: zs(R.date, true, 10),
    time: zs(R.time, true, 5),
    purpose: str,
    team: str,
    guests: z.coerce.number().int('Guests must be a whole number').min(1, 'At least 1 guest').max(20, 'Up to 20 guests').optional(),
  }).superRefine((v, ctx) => { const e = slotError(v.date ?? '', v.time ?? '', 'That slot'); if (e) ctx.addIssue({ code: 'custom', path: ['time'], message: e }); }),
  tech: z.object({
    type: z.string().min(1),
    client: zs(R.company, true, 120),
    date: zs(R.date, true, 10),
    time: zs(R.time, false, 5),
    duration: str,
    mode: str,
    link: zs(R.url, false, 500),
    context: zs(R.words(5), false, 4000),
  }).superRefine((v, ctx) => { const e = slotError(v.date ?? '', v.time ?? ''); if (e) ctx.addIssue({ code: 'custom', path: ['time'], message: e }); }),
  ticket: z.object({
    subject: zs(R.words(5, 150), true, 150),
    category: str,
    body: zs(R.words(5), false, 4000),
    escalate: z.boolean().optional(),
  }),
};

/** What an admin may change on a request (status is free text, as in the source). */
export const requestReview = z.object({
  status: z.string().min(1).optional(),
  comment: zs(R.words(3), false, 4000),
  assignee: zs(R.person, false, 80),
  approved: zMoney('Approved amount').optional(),
  date: day,
  time: zs(R.time, false, 5),
  link: zs(R.url, false, 500),
});

/** A partner's only change: accepting Mariox's revised amount on their own scope. */
export const acceptSchema = z.object({ accept: z.literal(true) });

/** When Mariox reschedules a visit or call, the new slot must still be ahead. */
export const reviewSlotError = (r) => (r.date ? slotError(r.date, r.time ?? '', 'That slot') : null);
