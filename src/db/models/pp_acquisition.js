import mongoose from 'mongoose';

/**
 * Partner acquisition lead: a person Mariox is recruiting as a partner (mariox-saas src/models/AcqLead.ts),
 * collection `pp_acquisition_leads`. Dates are YYYY-MM-DD strings in the team's local day.
 */
const { Schema } = mongoose;

const StepSchema = new Schema(
  {
    k: { type: String, required: true }, // contacted | meeting | done | moved | followup | converted | onboarding | rejected
    date: String,
    note: String,
    reason: String,
    missed: Boolean,
  },
  { _id: false },
);

const PpAcqLeadSchema = new Schema(
  {
    code: { type: String, unique: true }, // P-0001
    name: { type: String, required: true, trim: true },
    company: String,
    source: String,
    channel: String,
    owner: String, // team member who added the lead
    contactedAt: { type: String, required: true },
    status: { type: String, default: 'contacted', index: true },
    phone: String,
    email: String,
    linkedin: String,
    notes: String,
    services: [String],
    temp: { type: String, default: 'warm' },
    country: { type: String, default: 'India' },
    city: String,
    meet: {
      _id: false, date: String, time: String, link: String, duration: { type: Number, default: 30 }, attendees: [String],
      type: { type: String }, prep: [String], agenda: String, invited: Boolean,
    },
    next: String,
    convertedAt: String,
    onboardAt: String,
    rejectedAt: String,
    reason: String,
    partner: { type: Schema.Types.ObjectId, ref: 'PpUser' }, // set when converted
    steps: [StepSchema],
    sample: Boolean,
  },
  { timestamps: true, collection: 'pp_acquisition_leads' },
);

export const PpAcqLead = mongoose.models.PpAcqLead || mongoose.model('PpAcqLead', PpAcqLeadSchema);
