import { z } from 'zod';

export const setPasswordSchema = z.object({ token: z.string().min(10), password: z.string().min(8) });
export const forgotSchema = z.object({ email: z.string().trim().email('Enter a valid email') });
export const forgotVerifySchema = z.object({ email: z.string().trim().email(), otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
export const forgotResetSchema = z.object({
  email: z.string().trim().email(),
  token: z.string().min(10),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});
