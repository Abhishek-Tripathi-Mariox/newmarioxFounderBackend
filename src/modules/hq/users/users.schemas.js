import { z } from 'zod';
import { SEATS } from './seats.js';

export const objectId = z.string({ error: 'An id is required.' }).regex(/^[a-f\d]{24}$/i, { error: 'That id is not valid.' });

export const nameField = z
  .string({ error: 'Name is required.' })
  .trim()
  .min(1, { error: 'Name is required.' })
  .max(80, { error: 'Name can be at most 80 characters.' });

export const emailField = z
  .string({ error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }).max(254, { error: 'Email is too long.' }));

/** bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than silently truncated. */
export const newPasswordField = z
  .string({ error: 'Password is required.' })
  .min(8, { error: 'Password must be at least 8 characters.' })
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, { error: 'Password can be at most 72 characters.' });

export const userIdParams = z.object({ id: objectId });

export const createUserBody = z.object({
  name: nameField,
  email: emailField,
  password: newPasswordField,
  seat: z.enum(SEATS, { error: `Seat must be one of: ${SEATS.join(', ')}.` }).optional(),
});

export const updateUserBody = z
  .object({ name: nameField.optional(), email: emailField.optional() })
  .refine((body) => body.name !== undefined || body.email !== undefined, { error: 'Send a new name or email to update.' });

export const setPasswordBody = z.object({ password: newPasswordField });
