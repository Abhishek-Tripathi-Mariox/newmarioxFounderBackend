import mongoose from 'mongoose';

/**
 * The sealed founders' vault (collection `hq_vaults`). Encrypted in the browser (PBKDF2 + AES-GCM);
 * the server only stores the opaque base64 blob and never sees the passphrase or plaintext. One document.
 */
const hqVaultSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'main' },
    salt: { type: String, required: true },
    iv: { type: String, required: true },
    ct: { type: String, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'HqUser', default: null },
  },
  { collection: 'hq_vaults', timestamps: true, autoIndex: false },
);

export const HqVault = mongoose.models.HqVault ?? mongoose.model('HqVault', hqVaultSchema);
