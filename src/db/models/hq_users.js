import mongoose from 'mongoose';
import { HQ_SEATS } from './users.js';

export { HQ_SEATS };

/**
 * Founders HQ seat records (collection `hq_users`), one per seat. The account itself is the portal
 * user holding that seat (`users.hq_seat`, docs/SSO.md): sign-in, password and sessions live there.
 * This record is the HQ-side identity of the seat (workspace / vault authorship, UI prefs); it is
 * created on first use and its name / email follow the portal user (`user_id`).
 */
const hqUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    seat: { type: String, required: true, enum: HQ_SEATS, unique: true },
    /** The portal user (users.id) currently holding the seat. */
    user_id: { type: String, default: null },
    /** Per-user UI preferences for the HQ frontend (opaque to the server). */
    prefs: { type: mongoose.Schema.Types.Mixed, default: () => ({}), select: false },
  },
  { collection: 'hq_users', timestamps: true, minimize: false, autoIndex: false },
);

export const HqUser = mongoose.models.HqUser ?? mongoose.model('HqUser', hqUserSchema);
