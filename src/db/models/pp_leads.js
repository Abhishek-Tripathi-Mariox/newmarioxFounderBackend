import mongoose from 'mongoose';

/** A partner's sales lead (mariox-saas src/models/Lead.ts), collection `pp_leads`. */
const { Schema } = mongoose;

const TaskSchema = new Schema({
  text: { type: String, required: true },
  due: String, // YYYY-MM-DD
  done: { type: Boolean, default: false },
});

const ActivitySchema = new Schema(
  {
    type: { type: String, default: 'note' }, // call | meeting | email | note | stage | task | won
    text: { type: String, required: true },
    date: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const PpLeadSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'PpUser', required: true, index: true },
    company: { type: String, required: true, trim: true },
    project: String,
    value: { type: Number, default: 0 },
    contact: String,
    phone: String,
    email: String,
    city: String,
    source: String,
    priority: { type: String, default: 'Warm' },
    // Key of a stage from settings.pipeline.stages, or "won" / "lost".
    stage: { type: String, default: 'lead', index: true },
    lostReason: String,
    expectedClose: String,
    tasks: [TaskSchema],
    activities: [ActivitySchema],
  },
  { timestamps: true, collection: 'pp_leads' },
);

export const PpLead = mongoose.models.PpLead || mongoose.model('PpLead', PpLeadSchema);
