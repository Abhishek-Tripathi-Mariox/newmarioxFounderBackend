import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import multer from 'multer';
import { PpFile } from '../../../db/models/index.js';
import { downloadMode, storage } from '../../../core/storage/index.js';
import { PpError } from './http.js';

/**
 * Partner-portal file storage (mariox-saas src/lib/files.ts) on the backend's storage driver
 * (core/storage: S3 in production, local disk in tests / dev). Each upload gets a `pp_files` record
 * holding the storage key and who may read it.
 */
export const MAX_FILE_MB = 15;
export const MAX_VIDEO_MB = 25;
const ALLOWED = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|webp|gif|zip|mp4|m4v|mov|webm)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const maxMb = (name) => (VIDEO.test(name) ? MAX_VIDEO_MB : MAX_FILE_MB);
const MB = 1024 * 1024;

const safeName = (n) => n.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-120) || 'file';
/** Storage key: uploads/YYYY-MM/<uuid>/<safe-name> (same layout as the source bucket). */
const newKey = (name) => `uploads/${new Date().toISOString().slice(0, 7)}/${randomUUID()}/${safeName(name)}`;

const typeError = (name) => new PpError(400, `${name || 'File'}: only PDF, Word, Excel, PowerPoint, CSV, text, images, videos or ZIP`);
const sizeError = (name) => new PpError(400, `${name} is larger than ${maxMb(name)} MB`);

/**
 * Multer storage engine: streams each file straight to storage and enforces the per-type size
 * limit (15 MB, videos 25 MB); an oversized object is deleted again.
 */
const streamingStorage = {
  _handleFile(_req, file, cb) {
    const key = newKey(file.originalname);
    let size = 0;
    let truncated = false;
    const counter = new PassThrough();
    file.stream.on('data', (chunk) => { size += chunk.length; });
    file.stream.on('limit', () => { truncated = true; });
    file.stream.pipe(counter);
    storage.put(key, counter, { contentType: file.mimetype })
      .then(async () => {
        if (truncated || size > maxMb(file.originalname) * MB) {
          await storage.remove([key]).catch(() => {});
          return cb(sizeError(file.originalname));
        }
        cb(null, { key, size });
      })
      .catch(cb);
  },
  _removeFile(_req, file, cb) {
    storage.remove([file.key]).then(() => cb(null), cb);
  },
};

/** multipart/form-data, field "files", at most 10 files per request. */
export const uploadFiles = multer({
  storage: streamingStorage,
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_VIDEO_MB * MB, files: 10 },
  fileFilter: (_req, file, cb) => (file.originalname && ALLOWED.test(file.originalname) ? cb(null, true) : cb(typeError(file.originalname))),
}).array('files', 10);

/** Records the stored files → [{ fileId, name, size, type }]. */
export async function recordFiles(files, owner) {
  const saved = [];
  for (const f of files) {
    const type = f.mimetype || 'application/octet-stream';
    const rec = await PpFile.create({ key: f.key, name: f.originalname, size: f.size, type, owner });
    saved.push({ fileId: String(rec._id), name: f.originalname, size: f.size, type });
  }
  return saved;
}

/** The file record, or 404 "File not found" (also for a malformed id). */
export async function openFile(id) {
  const rec = await PpFile.findById(id).lean().catch(() => null);
  if (!rec) throw new PpError(404, 'File not found');
  return rec;
}

export async function setShared(id, shared) {
  if (!id) return;
  await PpFile.updateOne({ _id: id }, { shared });
}

/** Deletes the stored object (best effort) and its record. */
export async function deleteFile(id) {
  if (!id) return;
  const rec = await PpFile.findById(id).catch(() => null);
  if (!rec) return;
  await storage.remove([rec.key]).catch(() => {});
  await rec.deleteOne();
}

/**
 * Send a file to the browser: a 302 to a short-lived presigned URL when storage is S3 in "redirect"
 * mode (as the source did), otherwise streamed through the API. `download` saves instead of opening.
 */
export async function sendFile(res, f, download) {
  const disposition = `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  if (downloadMode === 'redirect') {
    const url = await storage.presign(f.key, { filename: download ? f.name : undefined, contentType: f.type });
    return res.redirect(302, url);
  }
  const obj = await storage.get(f.key);
  if (!obj) throw new PpError(404, 'File not found');
  res.setHeader('Content-Type', f.type || obj.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', disposition);
  if (obj.length != null) res.setHeader('Content-Length', String(obj.length));
  res.setHeader('Cache-Control', 'private, max-age=300');
  obj.stream.on('error', () => res.destroy());
  obj.stream.pipe(res);
}
