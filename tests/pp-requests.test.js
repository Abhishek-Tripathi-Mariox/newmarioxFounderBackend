import request from 'supertest';
import { app, closeDb } from './helpers.js';
import { PP, istDay, ppAgent, ppReset } from './pp-helpers.js';
import { PpFile, PpScope } from '../src/db/models/index.js';

let ids;
let admin;
let rohit;
let sana;
beforeAll(async () => {
  ids = await ppReset();
  [admin, rohit, sana] = await Promise.all([ppAgent('admin@pp.io'), ppAgent('rohit@pp.io'), ppAgent('sana@pp.io')]);
});
afterAll(closeDb);

test('unknown kind → 404', async () => {
  const res = await rohit.get(`${PP}/requests/visa`);
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Unknown request type "visa"');
  expect((await rohit.post(`${PP}/requests/__proto__`).send({})).status).toBe(404);
});

describe('scope', () => {
  test('submitted = Σ lines; only own uploads attach', async () => {
    const own = await PpFile.create({ owner: ids.rohit, key: 'uploads/t/own.pdf', name: 'own.pdf', size: 10, type: 'application/pdf' });
    const other = await PpFile.create({ owner: ids.sana, key: 'uploads/t/other.pdf', name: 'other.pdf', size: 10 });
    const body = { client: 'Acme Retail', project: 'Retail app', needs: 'A shopping app with loyalty points', lines: [{ name: 'Mobile app', amount: 300000 }, { name: 'Admin panel', amount: '150000' }] };
    const bad = await rohit.post(`${PP}/requests/scope`).send({ ...body, attachments: [{ fileId: String(other._id), name: 'other.pdf', size: 10, type: 'x' }] });
    expect(bad.body).toEqual({ error: 'Attachment not found' });
    const res = await rohit.post(`${PP}/requests/scope`).send({ ...body, attachments: [{ fileId: String(own._id), name: 'own.pdf', size: 10, type: 'application/pdf' }] });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ owner: ids.rohit, submitted: 450000, status: 'review' });
    expect((await rohit.post(`${PP}/requests/scope`).send({ client: 'Acme', project: '12' })).body.error).toBe('project: Title needs words, not only numbers (3–120 characters)');
  });

  test('partner accepts only a revised amount; review is admin-only otherwise', async () => {
    const scope = await PpScope.findOne({ owner: ids.rohit });
    expect((await rohit.patch(`${PP}/requests/scope/${scope._id}`).send({ accept: true })).body).toEqual({ error: 'Only a revised amount can be accepted' });
    expect((await rohit.patch(`${PP}/requests/scope/${scope._id}`).send({ status: 'approved' })).status).toBe(400);
    expect((await rohit.patch(`${PP}/requests/booking/${scope._id}`).send({ accept: true })).body).toEqual({ error: 'Admins only' });
    expect((await sana.patch(`${PP}/requests/scope/${scope._id}`).send({ accept: true })).body).toEqual({ error: 'Request not found' });

    const rev = await admin.patch(`${PP}/requests/scope/${scope._id}`).send({ status: 'revised', approved: 400000, comment: 'Reduced the admin panel' });
    expect(rev.body.item).toMatchObject({ status: 'revised', approved: 400000 });
    const ok = await rohit.patch(`${PP}/requests/scope/${scope._id}`).send({ accept: true });
    expect(ok.body.item).toMatchObject({ status: 'approved', comment: 'Reduced the admin panel Partner accepted the revised amount.' });
  });

  test('withdraw removes the attachments too', async () => {
    const scope = await PpScope.findOne({ owner: ids.rohit });
    expect((await sana.delete(`${PP}/requests/scope/${scope._id}`)).status).toBe(404);
    expect((await rohit.delete(`${PP}/requests/scope/${scope._id}`)).body).toEqual({ ok: true });
    expect(await PpFile.countDocuments({ owner: ids.rohit })).toBe(0);
  });
});

describe('booking + availability', () => {
  test('slot must be ahead; taken slots ignore declined / completed', async () => {
    const past = await rohit.post(`${PP}/requests/booking`).send({ client: 'Acme', office: 'Noida', date: istDay(-1), time: '10:00' });
    expect(past.body.error).toBe("time: Date can't be in the past");
    expect((await rohit.post(`${PP}/requests/booking`).send({ client: 'Acme', office: 'Noida', date: istDay(3), time: '10:00', guests: 25 })).body.error).toBe('guests: Up to 20 guests');

    const day = istDay(3);
    const a = await rohit.post(`${PP}/requests/booking`).send({ client: 'Acme', office: 'Noida', date: day, time: '10:00', purpose: 'Client pitch', team: 'Tech Lead', guests: 3 });
    expect(a.body.item).toMatchObject({ status: 'Requested', guests: 3 });
    const b = await sana.post(`${PP}/requests/booking`).send({ client: 'Kaveri', office: 'Noida', date: day, time: '11:30' });
    await admin.patch(`${PP}/requests/booking/${b.body.item._id}`).send({ status: 'Declined' });

    const av = await sana.get(`${PP}/availability?office=Noida&date=${day}`);
    expect(av.body).toEqual({ taken: ['10:00'] });
    expect((await sana.get(`${PP}/availability?office=Noida`)).body).toEqual({ error: 'office and date (YYYY-MM-DD) are required' });
    expect((await request(app).get(`${PP}/availability?office=Noida&date=${day}`)).status).toBe(401);
  });

  test('admin reschedule must still be ahead', async () => {
    const item = (await admin.get(`${PP}/requests/booking?status=Requested`)).body.items[0];
    expect((await admin.patch(`${PP}/requests/booking/${item._id}`).send({ date: istDay(-2), time: '10:00' })).body).toEqual({ error: "Date can't be in the past" });
    const res = await admin.patch(`${PP}/requests/booking/${item._id}`).send({ status: 'Rescheduled', date: istDay(5), time: '14:30', comment: 'Moved by the team' });
    expect(res.body.item).toMatchObject({ status: 'Rescheduled', date: istDay(5), time: '14:30' });
  });
});

describe('tech', () => {
  test('create and assign', async () => {
    const bad = await rohit.post(`${PP}/requests/tech`).send({ type: 'Live demo', client: 'Acme', date: istDay(2), link: 'not a link' });
    expect(bad.body.error).toBe('link: Enter a full link starting with https://');
    const res = await rohit.post(`${PP}/requests/tech`).send({ type: 'Live demo', client: 'Acme', date: istDay(2), time: '11:00', duration: '45 min', mode: 'Google Meet', context: 'They want to see the CRM product' });
    expect(res.body.item).toMatchObject({ status: 'requested', type: 'Live demo' });
    const as = await admin.patch(`${PP}/requests/tech/${res.body.item._id}`).send({ status: 'assigned', assignee: 'Karan Malhotra', link: 'https://meet.google.com/abc-defg-hij' });
    expect(as.body.item).toMatchObject({ status: 'assigned', assignee: 'Karan Malhotra' });
    expect((await admin.patch(`${PP}/requests/tech/${res.body.item._id}`).send({ assignee: '42' })).status).toBe(400);
  });
});

describe('ticket', () => {
  test('codes TK-2001…, escalation assigns', async () => {
    const t1 = await rohit.post(`${PP}/requests/ticket`).send({ subject: 'My payout is late again', category: 'Commission & payout', body: 'Payment from Acme received last week', escalate: true });
    expect(t1.body.item).toMatchObject({ code: 'TK-2001', status: 'assigned', escalate: true });
    const t2 = await sana.post(`${PP}/requests/ticket`).send({ subject: 'Need the new sales deck' });
    expect(t2.body.item).toMatchObject({ code: 'TK-2002', status: 'requested' });
    expect((await sana.post(`${PP}/requests/ticket`).send({ subject: 'Hi' })).status).toBe(400);
  });

  test('list: own only for partners, owner filter for admins, search and status', async () => {
    expect((await rohit.get(`${PP}/requests/ticket`)).body.items.map((t) => t.code)).toEqual(['TK-2001']);
    expect((await rohit.get(`${PP}/requests/ticket?owner=${ids.sana}`)).body.items.map((t) => t.code)).toEqual(['TK-2001']);
    const all = await admin.get(`${PP}/requests/ticket?page=1&limit=10`);
    expect(all.body.meta).toEqual({ page: 1, limit: 10, total: 2, pages: 1 });
    expect(all.body.items.map((t) => t.code)).toEqual(['TK-2002', 'TK-2001']);
    expect(all.body.items[0].owner).toMatchObject({ name: 'Sana Khan', partnerCode: 'MX-P-243-2' });
    expect((await admin.get(`${PP}/requests/ticket?owner=${ids.rohit}`)).body.items).toHaveLength(1);
    expect((await admin.get(`${PP}/requests/ticket?q=deck`)).body.items.map((t) => t.code)).toEqual(['TK-2002']);
    expect((await admin.get(`${PP}/requests/ticket?status=requested,completed`)).body.items.map((t) => t.code)).toEqual(['TK-2002']);
  });
});
