import { HqVault } from '../../../db/models/hq_vaults.js';

const VAULT_KEY = 'main';

/** Only the sealed fields ever leave the server. */
const toSealed = (doc) => (doc ? { salt: doc.salt, iv: doc.iv, ct: doc.ct } : null);

/** The sealed vault blob, or null if it was never created. */
export async function getVault() {
  return toSealed(await HqVault.findOne({ key: VAULT_KEY }).lean());
}

/**
 * Replace the sealed vault blob (ciphertext only: the server never sees the passphrase or plaintext).
 * @param {{ salt: string, iv: string, ct: string }} sealed
 * @param {unknown} userId
 */
export async function saveVault({ salt, iv, ct }, userId) {
  const doc = await HqVault.findOneAndUpdate({ key: VAULT_KEY }, { $set: { salt, iv, ct, updatedBy: userId } }, { new: true, upsert: true, lean: true });
  return toSealed(doc);
}
