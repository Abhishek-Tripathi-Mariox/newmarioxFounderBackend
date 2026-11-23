import { z } from 'zod';
import { profileFields } from '../lib/users.js';

/** Partners edit their own contact and payout details, never role, rate or status. */
export const profileSchema = z.object(profileFields);
export const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Use at least 8 characters').max(128),
});
