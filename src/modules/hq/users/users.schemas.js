import { z } from 'zod';
import { HQ_ROLES, LEGACY_SEATS } from './seats.js';

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
  /** 'founder' | 'cofounder' (any number of each); default: founder for the first member, else co-founder. */
  role: z.enum(HQ_ROLES, { error: `Role must be one of: ${HQ_ROLES.join(', ')}.` }).optional(),
  /** Older clients: one of the two original person ids, which must be free. */
  seat: z.enum(LEGACY_SEATS, { error: `Seat must be one of: ${LEGACY_SEATS.join(', ')}.` }).optional(),
});

export const updateUserBody = z
  .object({
    name: nameField.optional(),
    email: emailField.optional(),
    role: z.enum(HQ_ROLES, { error: `Role must be one of: ${HQ_ROLES.join(', ')}.` }).optional(),
  })
  .refine((body) => body.name !== undefined || body.email !== undefined || body.role !== undefined, { error: 'Send a new name or email to update.' });

export const setPasswordBody = z.object({ password: newPasswordField });
