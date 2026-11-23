import { defineModel, int, text, ts, PK, REQUIRED } from '../modelKit.js';

/**
 * Self-service "forgot password" state (POST /auth/forgot*, also behind /pp/auth/forgot*), one document
 * per email address asked about. `_id` (`key`) = sha256 of the lower-cased email, so addresses that
 * have no account are not stored in clear. Every request gets a document — also for unknown or
 * inactive addresses (`user_id` null, a code that is never sent) — so cooldown, wrong-code counts and
 * answers are the same whether or not an account exists. Only hashes of the code and the reset token
 * are stored. Documents expire by themselves (TTL index on `purge_at`).
 */
export const PasswordReset = defineModel('password_resets', {
  user_id: text(), // → users; null when no Active account has this email
  otp_hash: text(), // sha256(key:code); null once used
  otp_expires_at: ts(),
  sent_at: ts(REQUIRED), // last code request (resend cooldown)
  attempts: int(0), // wrong codes for the current code
  token_hash: text(), // sha256 of the single-use reset token handed out after a right code
  token_expires_at: ts(),
  purge_at: ts(REQUIRED),
}, {
  pk: PK.text,
  pkColumn: 'key',
  indexes: [
    [{ token_hash: 1 }, { unique: true, partialFilterExpression: { token_hash: { $type: 'string' } } }],
    [{ purge_at: 1 }, { expireAfterSeconds: 0 }],
  ],
});
