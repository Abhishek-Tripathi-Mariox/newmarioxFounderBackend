import mongoose from 'mongoose';

/** Audit trail of HQ workspace saves (collection `hq_workspace_revisions`): who saved which version and when. */
const hqWorkspaceRevisionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'HqUser', required: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { collection: 'hq_workspace_revisions', versionKey: false, autoIndex: false },
);

export const HqWorkspaceRevision =
  mongoose.models.HqWorkspaceRevision ?? mongoose.model('HqWorkspaceRevision', hqWorkspaceRevisionSchema);
