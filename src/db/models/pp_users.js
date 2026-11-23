import mongoose from 'mongoose';

/**
 * Mariox Partners profile (partner or partner-portal admin). Copied from mariox-saas src/models/User.ts;
 * field names unchanged, collection `pp_users`. The sign-in account is the portal user linked by
 * `users.pp_user_id` (docs/SSO.md): password and sessions live there; `status` mirrors the portal
 * user's (invited ↔ Invited, active ↔ Active, disabled ↔ Deactivated).
 */
const { Schema } = mongoose;

/** Commission share a new partner gets unless one is given (50 %). */
export const PP_DEFAULT_COMMISSION_RATE = 0.5;

const PpUserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, enum: ['admin', 'partner'], default: 'partner' },
    status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
    partnerCode: { type: String, unique: true, sparse: true },
    company: String,
    phone: String,
    city: String,
    industries: String,
    pan: String,
    gstin: String,
    bankAccount: String,
    ifsc: String,
    commissionRate: { type: Number, default: PP_DEFAULT_COMMISSION_RATE },
    // Where the account came from: admin | main-site | acquisition | seed.
    source: { type: String, default: 'admin' },
    externalId: { type: String, index: true, sparse: true },
    inviteToken: { type: String, index: true, select: false },
    inviteExpires: { type: Date, select: false },
    // Legacy partner-only forgot-password state, no longer written: forgot password is the portal's
    // flow for every account now (collection password_resets, modules/auth/passwordReset.js).
    resetOtpHash: { type: String, select: false },
    resetOtpExpires: { type: Date, select: false },
    resetOtpSentAt: { type: Date, select: false },
    resetOtpAttempts: { type: Number, select: false },
    resetTokenHash: { type: String, select: false },
    resetTokenExpires: { type: Date, select: false },
    lastLoginAt: Date,
  },
  { timestamps: true, collection: 'pp_users' },
);

export const PpUser = mongoose.models.PpUser || mongoose.model('PpUser', PpUserSchema);
