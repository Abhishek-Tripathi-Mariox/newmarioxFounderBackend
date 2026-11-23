import mongoose from 'mongoose';

/**
 * Index of partner-portal uploads (mariox-saas src/models/File.ts), collection `pp_files`. The bytes
 * live in the configured storage under `key`; `owner` is the uploader, `shared` makes it readable by
 * every signed-in user (visible sales kit files).
 */
const { Schema } = mongoose;

const PpFileSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    size: { type: Number, required: true },
    type: { type: String, default: 'application/octet-stream' },
    owner: { type: Schema.Types.ObjectId, ref: 'PpUser', required: true, index: true },
    shared: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'pp_files' },
);

export const PpFile = mongoose.models.PpFile || mongoose.model('PpFile', PpFileSchema);
