import { z } from 'zod';

const email = z.string().trim().max(254);
const password = z.string().min(8, 'Use at least 8 characters.').max(128);

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const refreshSchema = z.object({ refreshToken: z.string().max(200).optional() });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const acceptInviteSchema = z.object({ email, token: z.string().min(10).max(200), password });
export const resetPasswordSchema = z.object({ email, token: z.string().min(10).max(200), password });

// Forgot password (self-service, any account): email → 6-digit code → single-use token + new password.
export const forgotSchema = z.object({ email: z.string().trim().email('Enter a valid email.').max(254) });
export const forgotVerifySchema = z.object({ email: z.string().trim().email().max(254), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') });
export const forgotResetSchema = z.object({ token: z.string().min(10).max(200), password });
