import mongoose from 'mongoose';

/** Sales kit item shown to partners (mariox-saas src/models/Content.ts → Resource), collection `pp_resources`. */
const { Schema } = mongoose;

const PpResourceSchema = new Schema(
  {
    type: { type: String, required: true },
    industry: { type: String, default: 'All' },
    title: { type: String, required: true },
    format: String,
    size: String,
    url: String, // optional external link (used when no file is uploaded)
    file: { _id: false, fileId: String, name: String, size: Number, type: { type: String } },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'pp_resources' },
);

export const PpResource = mongoose.models.PpResource || mongoose.model('PpResource', PpResourceSchema);
