import { openFile, recordFiles } from '../lib/files.js';
import { PpError } from '../lib/http.js';
import { adminMay } from '../lib/session.js';

/** Partner-portal uploads (mariox-saas src/app/api/uploads/**). */

/** Records the files multer stored → [{ fileId, name, size, type }]. */
export async function saveUploads(s, files) {
  if (!files?.length) throw new PpError(400, 'No files received');
  return recordFiles(files, s.sub);
}

/** Sections whose pages show partners' files (request attachments, kit files). */
const FILE_SECTIONS = ['pp_requests', 'pp_partners', 'pp_kit', 'pp_leads', 'pp_projects'];

/**
 * A file the caller may read: the uploader, anyone when shared (visible kit files), and admins whose
 * role can view a section that shows files.
 */
export async function readable(s, id) {
  const f = await openFile(id);
  const admin = FILE_SECTIONS.some((m) => adminMay(s, m, 'v'));
  if (!admin && !f.shared && String(f.owner) !== s.sub) throw new PpError(404, 'File not found');
  return f;
}
