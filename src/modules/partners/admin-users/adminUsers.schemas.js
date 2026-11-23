import { z } from 'zod';
import { newPartnerSchema, profileFields } from '../lib/users.js';

/** From the admin panel the admin sets the password; the partner is emailed their login details. */
export const adminNewPartnerSchema = newPartnerSchema.extend({ password: z.string().min(8, 'Password must be at least 8 characters') });

export const adminPatchSchema = z.object({
  ...profileFields,
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254).optional(),
  status: z.enum(['invited', 'active', 'disabled']).optional(),
  commissionRate: z.number().min(0).max(1).optional(),
  password: z.string().min(8).optional(), // admin sets a new password
  newInvite: z.boolean().optional(), // admin generates a fresh set-password link (emailed)
  emailPassword: z.boolean().optional(), // with password: email the partner their new login details
});
