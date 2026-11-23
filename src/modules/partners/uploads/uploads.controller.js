import { sendFile, uploadFiles } from '../lib/files.js';
import { PpError, searchParams } from '../lib/http.js';
import * as svc from './uploads.service.js';

/** Streams the multipart files to storage (field "files", max 10), then records them. */
export function receive(req, res, next) {
  if (!req.is('multipart/form-data')) return next(new PpError(400, 'Send files as multipart/form-data'));
  return uploadFiles(req, res, next);
}

export const create = async (req, res) => res.status(201).json({ files: await svc.saveUploads(req.pp, req.files) });

export async function download(req, res) {
  const f = await svc.readable(req.pp, req.params.id);
  await sendFile(res, f, searchParams(req).get('download') === '1');
}
