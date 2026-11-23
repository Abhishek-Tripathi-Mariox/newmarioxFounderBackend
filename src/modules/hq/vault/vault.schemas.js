import { z } from 'zod';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const MAX_CIPHERTEXT_LENGTH = 2 * 1024 * 1024;

const base64Field = (label, maxLength) =>
  z
    .string({ error: `${label} is required.` })
    .min(1, { error: `${label} is required.` })
    .max(maxLength, { error: `${label} is too large.` })
    .regex(BASE64, { error: `${label} must be base64.` });

export const saveVaultBody = z.object({
  salt: base64Field('salt', 1024),
  iv: base64Field('iv', 1024),
  ct: base64Field('ct', MAX_CIPHERTEXT_LENGTH),
});
