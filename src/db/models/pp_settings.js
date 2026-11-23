import mongoose from 'mongoose';

/**
 * Partner-portal settings (mariox-saas src/models/Content.ts → Setting): one document `key: 'portal'`
 * with contacts, announcement, sales pipeline and acquisition lists. Collection `pp_settings`.
 */
const { Schema } = mongoose;

const PpSettingSchema = new Schema(
  {
    key: { type: String, unique: true, default: 'portal' },
    contacts: [{ _id: false, title: String, name: String, role: String, phone: String, email: String, note: String }],
    announcement: String,
    pipeline: {
      stages: [{ _id: false, key: String, name: String, prob: Number }],
      sources: [String],
      priorities: [{ _id: false, name: String, tone: String }],
      lostReasons: [String],
    },
    acquisition: {
      _id: false, team: [String], sources: [String], channels: [String], reasons: [String], services: [String], countries: [String],
      emails: { type: Map, of: String },
    },
  },
  { timestamps: true, collection: 'pp_settings' },
);

export const PpSetting = mongoose.models.PpSetting || mongoose.model('PpSetting', PpSettingSchema);
