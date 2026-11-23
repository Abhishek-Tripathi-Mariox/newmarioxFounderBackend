import request from 'supertest';
import { app, closeDb } from './helpers.js';
import { PP, ppAgent, ppReset } from './pp-helpers.js';
import { PpFile } from '../src/db/models/index.js';
import { storage } from '../src/core/storage/index.js';

let admin;
let rohit;
let sana;
beforeAll(async () => {
  await ppReset();
  [admin, rohit, sana] = await Promise.all([ppAgent('admin@pp.io'), ppAgent('rohit@pp.io'), ppAgent('sana@pp.io')]);
});
afterAll(closeDb);

const upload = (agent, name, content = 'hello world', extra = []) => {
  let req = agent.post(`${PP}/uploads`).attach('files', Buffer.from(content), name);
  for (const [n, c] of extra) req = req.attach('files', Buffer.from(c), n);
  return req;
};

describe('uploads (local storage driver)', () => {
  test('stores files and returns {files:[{fileId,name,size,type}]} with 201', async () => {
    const res = await upload(rohit, 'brief.pdf', '%PDF-1.4 test', [['notes.txt', 'abc']]);
    expect(res.status).toBe(201);
    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[0]).toMatchObject({ name: 'brief.pdf', size: 13, type: 'application/pdf' });
    const rec = await PpFile.findById(res.body.files[0].fileId).lean();
    expect(rec.key).toMatch(/^uploads\/\d{4}-\d\d\/[0-9a-f-]{36}\/brief\.pdf$/);
    expect(await storage.get(rec.key)).not.toBeNull();
  });

  test('rejects other types, no files, non-multipart, more than 10', async () => {
    expect((await upload(rohit, 'run.exe')).body).toEqual({ error: 'run.exe: only PDF, Word, Excel, PowerPoint, CSV, text, images, videos or ZIP' });
    expect((await rohit.post(`${PP}/uploads`).field('x', '1')).body).toEqual({ error: 'No files received' });
    expect((await rohit.post(`${PP}/uploads`).send({ a: 1 })).body).toEqual({ error: 'Send files as multipart/form-data' });
    const eleven = Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, 'x']);
    expect((await upload(rohit, 'first.txt', 'x', eleven)).body).toEqual({ error: 'Up to 10 files at a time' });
  });

  test('a non-video over 15 MB is refused and not kept', async () => {
    const before = await PpFile.countDocuments();
    const res = await upload(rohit, 'big.pdf', 'x'.repeat(15 * 1024 * 1024 + 1));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('big.pdf is larger than 15 MB');
    expect(await PpFile.countDocuments()).toBe(before);
  });

  test('GET /uploads/:id: uploader and admins read, others 404; download=1 → attachment', async () => {
    const { fileId } = (await upload(rohit, 'secret.txt', 'top secret')).body.files[0];
    const own = await rohit.get(`${PP}/uploads/${fileId}`);
    expect(own.status).toBe(200);
    expect(own.text).toBe('top secret');
    expect(own.headers['content-disposition']).toMatch(/^inline; filename\*=UTF-8''secret\.txt$/);
    const dl = await admin.get(`${PP}/uploads/${fileId}?download=1`);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect((await sana.get(`${PP}/uploads/${fileId}`)).body).toEqual({ error: 'File not found' });
    expect((await sana.get(`${PP}/uploads/nope`)).status).toBe(404);
    expect((await request(app).get(`${PP}/uploads/${fileId}`)).status).toBe(401);
  });
});

describe('resources (sales kit)', () => {
  let fileA;
  let fileB;
  let item;
  beforeAll(async () => {
    fileA = (await upload(admin, 'case.pdf', 'case study')).body.files[0];
    fileB = (await upload(admin, 'deck.pdf', 'deck v2')).body.files[0];
  });

  test('create: file must exist; visible kit files become shared', async () => {
    expect((await admin.post(`${PP}/resources`).send({ type: 'Deck', title: 'Ghost deck', file: { fileId: '64b000000000000000000000', name: 'x', size: 1, type: 'x' } })).body).toEqual({ error: 'File not found' });
    expect((await admin.post(`${PP}/resources`).send({ type: 'Deck', title: '12' })).status).toBe(400);
    const res = await admin.post(`${PP}/resources`).send({ type: 'Case study', title: 'Retail case study', industry: 'Retail', format: 'PDF', size: '1.2 MB', file: fileA });
    expect(res.status).toBe(201);
    item = res.body.item;
    expect(item).toMatchObject({ industry: 'Retail', hidden: false, file: { fileId: fileA.fileId } });
    expect((await PpFile.findById(fileA.fileId).lean()).shared).toBe(true);
    expect((await rohit.get(`${PP}/uploads/${fileA.fileId}`)).status).toBe(200);
    await admin.post(`${PP}/resources`).send({ type: 'Brochure', title: 'Company brochure', url: 'https://mariox.in/brochure.pdf' });
    await admin.post(`${PP}/resources`).send({ type: 'Deck', title: 'Secret deck', url: 'https://mariox.in/deck.pdf', hidden: true });
  });

  test('list: partners never see hidden; search, type filter, default sort by type', async () => {
    expect((await rohit.get(`${PP}/resources`)).body.items.map((r) => r.title)).toEqual(['Company brochure', 'Retail case study']);
    expect((await admin.get(`${PP}/resources`)).body.items).toHaveLength(3);
    const p = await admin.get(`${PP}/resources?page=1&limit=10&type=Deck`);
    expect(p.body.meta.total).toBe(1);
    expect((await rohit.get(`${PP}/resources?q=retail`)).body.items).toHaveLength(1);
  });

  test('hiding unshares the file; replacing deletes the old one', async () => {
    let res = await admin.patch(`${PP}/resources/${item._id}`).send({ hidden: true });
    expect(res.body.item.hidden).toBe(true);
    expect((await PpFile.findById(fileA.fileId).lean()).shared).toBe(false);
    expect((await rohit.get(`${PP}/uploads/${fileA.fileId}`)).status).toBe(404);

    const oldKey = (await PpFile.findById(fileA.fileId).lean()).key;
    res = await admin.patch(`${PP}/resources/${item._id}`).send({ hidden: false, file: fileB });
    expect(res.body.item.file.fileId).toBe(fileB.fileId);
    expect(await PpFile.countDocuments({ _id: fileA.fileId })).toBe(0);
    expect(await storage.get(oldKey)).toBeNull();
    expect((await PpFile.findById(fileB.fileId).lean()).shared).toBe(true);
    expect((await admin.patch(`${PP}/resources/64b000000000000000000000`).send({ hidden: true })).body).toEqual({ error: 'Resource not found' });
  });

  test('delete removes the file', async () => {
    expect((await admin.delete(`${PP}/resources/${item._id}`)).body).toEqual({ ok: true });
    expect(await PpFile.countDocuments({ _id: fileB.fileId })).toBe(0);
  });
});
