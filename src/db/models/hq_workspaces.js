import mongoose from 'mongoose';

/**
 * The single shared Founders HQ workspace (collection `hq_workspaces`). Exactly one document
 * (key "main"); `version` increases by one on every save and drives optimistic concurrency.
 */
const hqWorkspaceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'main' },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    version: { type: Number, required: true, default: 0, min: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'HqUser', default: null },
  },
  { collection: 'hq_workspaces', timestamps: true, minimize: false, autoIndex: false },
);

export const HqWorkspace = mongoose.models.HqWorkspace ?? mongoose.model('HqWorkspace', hqWorkspaceSchema);
