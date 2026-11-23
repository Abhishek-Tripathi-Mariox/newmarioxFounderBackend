import mongoose from 'mongoose';

/**
 * What a partner asks Mariox for (mariox-saas src/models/Requests.ts): scope approvals, office visit
 * bookings, technical-team requests and support tickets. One collection per kind, prefixed `pp_`.
 */
const { Schema } = mongoose;

const owner = { type: Schema.Types.ObjectId, ref: 'PpUser', required: true, index: true };
const model = (name, collection, fields) =>
  mongoose.models[name] || mongoose.model(name, new Schema({ owner, ...fields }, { timestamps: true, collection }));

export const PpScope = model('PpScope', 'pp_scope_requests', {
  client: { type: String, required: true },
  project: { type: String, required: true },
  needs: String,
  lines: [{ name: String, amount: Number }],
  // `type` is wrapped so mongoose doesn't read it as the field's type.
  attachments: [{ _id: false, fileId: String, name: String, size: Number, type: { type: String } }],
  submitted: { type: Number, default: 0 },
  approved: Number,
  status: { type: String, default: 'review' },
  comment: String,
});

export const PpBooking = model('PpBooking', 'pp_booking_requests', {
  client: { type: String, required: true },
  office: String,
  date: String,
  time: String,
  purpose: String,
  team: String,
  guests: Number,
  status: { type: String, default: 'Requested' },
  comment: String,
});

export const PpTechRequest = model('PpTechRequest', 'pp_tech_requests', {
  type: { type: String, required: true },
  client: { type: String, required: true },
  date: String,
  time: String,
  duration: String,
  mode: String,
  link: String,
  context: String,
  status: { type: String, default: 'requested' },
  assignee: String,
  comment: String,
});

export const PpTicket = model('PpTicket', 'pp_ticket_requests', {
  code: { type: String, unique: true },
  subject: { type: String, required: true },
  category: String,
  body: String,
  escalate: { type: Boolean, default: false },
  status: { type: String, default: 'requested' },
  assignee: String,
  comment: String,
});
