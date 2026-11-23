import { z } from 'zod';
import { newPasswordField } from '../users/users.schemas.js';

export const changePasswordBody = z.object({
  currentPassword: z.string({ error: 'Your current password is required.' }).min(1, { error: 'Your current password is required.' }).max(1024),
  newPassword: newPasswordField,
});
