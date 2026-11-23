import { PpResource } from '../../../db/models/index.js';
import { deleteFile, openFile, setShared } from '../lib/files.js';
import { PpError } from '../lib/http.js';
import { eq, runList } from '../lib/list.js';

/**
 * Sales kit (mariox-saas src/app/api/resources/**). Partners never see hidden items. A kit file is
 * `shared` (readable by every partner) exactly while its item is visible.
 */
const LIST = {
  search: ['title', 'industry', 'type', 'format'],
  sorts: ['title', 'type', 'createdAt'],
  defaultSort: 'type',
  filters: { type: eq('type') },
};

export const list = (s, req) => runList(PpResource, s.role === 'admin' ? {} : { hidden: { $ne: true } }, req, LIST);

export async function create(data) {
  if (data.file) await openFile(data.file.fileId); // must exist
  const item = await PpResource.create({ ...data, file: data.file ?? undefined });
  await setShared(item.file?.fileId, !item.hidden);
  return item;
}

export async function find(id) {
  const item = await PpResource.findById(id);
  if (!item) throw new PpError(404, 'Resource not found');
  return item;
}

/** Replacing or removing the file deletes the old one from storage. */
export async function update(item, data) {
  const oldFileId = item.file?.fileId;

  if (data.file) await openFile(data.file.fileId);
  item.set({ ...data, file: data.file === undefined ? item.file : data.file ?? undefined });
  await item.save();

  const newFileId = item.file?.fileId;
  if (oldFileId && oldFileId !== newFileId) await deleteFile(oldFileId);
  await setShared(newFileId, !item.hidden);
  return item;
}

export async function remove(id) {
  const item = await PpResource.findByIdAndDelete(id);
  await deleteFile(item?.file?.fileId);
}
