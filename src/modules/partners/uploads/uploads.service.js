import { openFile, recordFiles } from '../lib/files.js';
import { PpError } from '../lib/http.js';

/** Partner-portal uploads (mariox-saas src/app/api/uploads/**). */

/** Records the files multer stored → [{ fileId, name, size, type }]. */
export async function saveUploads(s, files) {
  if (!files?.length) throw new PpError(400, 'No files received');
  return recordFiles(files, s.sub);
}

/** A file the caller may read: admins, the uploader, or anyone when shared (visible kit files). */
export async function readable(s, id) {
  const f = await openFile(id);
  if (s.role !== 'admin' && !f.shared && String(f.owner) !== s.sub) throw new PpError(404, 'File not found');
  return f;
}
