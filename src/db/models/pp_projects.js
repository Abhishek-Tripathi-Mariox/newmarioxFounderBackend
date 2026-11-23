import mongoose from 'mongoose';

/** A won partner deal Mariox is delivering (mariox-saas src/models/Project.ts), collection `pp_projects`. */
const { Schema } = mongoose;

const PaymentSchema = new Schema({
  label: { type: String, required: true },
  amount: { type: Number, required: true },
  due: String,
  status: { type: String, enum: ['upcoming', 'due', 'received'], default: 'upcoming' },
  // Set when the partner's commission on this payment has been paid out.
  releasedAt: String,
  utr: String,
});

const PpProjectSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'PpUser', required: true, index: true },
    lead: { type: Schema.Types.ObjectId, ref: 'PpLead' },
    client: { type: String, required: true },
    contact: String,
    city: String,
    title: { type: String, required: true },
    deal: { type: Number, default: 0 },
    // Commission share for THIS deal (0–1), locked when the project is created.
    commissionRate: { type: Number, min: 0, max: 1 },
    closedAt: String,
    stage: { type: Number, default: 0, min: 0, max: 4 },
    pm: String,
    update: String,
    milestones: [String], // one date per delivery stage
    payments: [PaymentSchema],
  },
  { timestamps: true, collection: 'pp_projects' },
);

export const PpProject = mongoose.models.PpProject || mongoose.model('PpProject', PpProjectSchema);
