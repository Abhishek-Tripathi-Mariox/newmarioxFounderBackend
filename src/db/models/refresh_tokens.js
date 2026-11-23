import { defineModel, text, ts, REQUIRED, PK } from '../modelKit.js';

/** Refresh tokens: only the sha256 of each opaque token is stored. Deleted with their user. */
export const RefreshToken = defineModel('refresh_tokens', {
  user_id: text(REQUIRED), // → users, CASCADE
  token_hash: text(REQUIRED),
  expires_at: ts(REQUIRED),
  revoked_at: ts(),
  user_agent: text(),
  ip: text(),
}, { pk: PK.uuid, stamps: 'created', indexes: [[{ token_hash: 1 }, { unique: true }], [{ user_id: 1 }]] });
