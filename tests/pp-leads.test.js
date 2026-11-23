import { closeDb } from './helpers.js';
import { PP, istDay, ppAgent, ppReset } from './pp-helpers.js';
import { PpLead } from '../src/db/models/index.js';

let ids;
let admin;
let rohit;
let sana;
beforeAll(async () => {
  ids = await ppReset();
  [admin, rohit, sana] = await Promise.all([ppAgent('admin@pp.io'), ppAgent('rohit@pp.io'), ppAgent('sana@pp.io')]);
});
afterAll(closeDb);

describe('create', () => {
  test('partner creates own lead: first stage, first call tomorrow, "Lead created"', async () => {
    const res = await rohit.post(`${PP}/leads`).send({ company: 'Zenvy Retail', project: 'Shop app', value: '800000', contact: 'Ankit Mehta', phone: '98765 43210', email: 'ankit@zenvy.com', city: 'Noida', source: 'Referral', owner: ids.sana });
    expect(res.status).toBe(201);
    const { lead } = res.body;
    expect(lead).toMatchObject({ owner: ids.rohit, company: 'Zenvy Retail', value: 800000, stage: 'lead', priority: 'Warm', phone: '+91 9876543210' });
    expect(lead.tasks).toHaveLength(1);
    expect(lead.tasks[0]).toMatchObject({ text: 'First call', done: false, due: new Date(Date.now() + 864e5).toISOString().slice(0, 10) });
    expect(lead.activities.map((a) => [a.type, a.text])).toEqual([['note', 'Lead created']]);
  });

  test('validation messages from the shared rules', async () => {
    const r1 = await rohit.post(`${PP}/leads`).send({ company: '1234' });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('company: Enter a real name with letters (2–120 characters)');
    expect((await rohit.post(`${PP}/leads`).send({ company: 'Acme', phone: '12345' })).body.error).toBe('phone: India numbers have 10 digits');
    expect((await rohit.post(`${PP}/leads`).send({ company: 'Acme', stage: 'nope' })).body).toEqual({ error: 'Unknown stage' });
    expect((await rohit.post(`${PP}/leads`).send({ company: 'Acme', value: -5 })).body.error).toBe('value: Estimated value must be between ₹0 and ₹1,000 crore');
  });

  test('admin must name a real partner; activity says "by Mariox"', async () => {
    expect((await admin.post(`${PP}/leads`).send({ company: 'Acme' })).body).toEqual({ error: 'Choose the partner this lead belongs to' });
    expect((await admin.post(`${PP}/leads`).send({ company: 'Acme', owner: ids.admin })).body).toEqual({ error: 'Choose the partner this lead belongs to' });
    expect((await admin.post(`${PP}/leads`).send({ company: 'Acme', owner: '64b000000000000000000000' })).body).toEqual({ error: 'Unknown partner' });
    const res = await admin.post(`${PP}/leads`).send({ company: 'Kaveri Foods', owner: ids.sana, value: 350000, stage: 'proposal' });
    expect(res.status).toBe(201);
    expect(res.body.lead).toMatchObject({ owner: ids.sana, stage: 'proposal' });
    expect(res.body.lead.activities[0].text).toBe('Lead created by Mariox');
  });
});

describe('list protocol', () => {
  beforeAll(async () => {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push({ owner: ids.rohit, company: `Batch ${String(i).padStart(2, '0')}`, value: i * 1000, stage: i % 3 === 0 ? 'won' : 'contacted', source: i % 2 ? 'LinkedIn' : 'Event', priority: i <= 2 ? 'Hot' : 'Cold', city: i === 7 ? 'Pune' : 'Delhi' });
    await PpLead.insertMany(rows);
  });

  test('partners see only their own; unpaged returns everything without meta', async () => {
    const all = await rohit.get(`${PP}/leads`);
    expect(all.body.meta).toBeUndefined();
    expect(all.body.leads).toHaveLength(13);
    expect(all.body.leads.every((l) => l.owner._id === ids.rohit)).toBe(true);
    expect(all.body.leads[0].owner).toMatchObject({ name: 'Rohit Sharma', partnerCode: 'MX-P-243-1', commissionRate: 0.5 });
    expect((await sana.get(`${PP}/leads`)).body.leads.map((l) => l.company)).toEqual(['Kaveri Foods']);
  });

  test('paging, sort allow-list with _id tiebreak, search, comma filters', async () => {
    const p1 = await rohit.get(`${PP}/leads?page=1&limit=10&sort=-value`);
    expect(p1.body.meta).toEqual({ page: 1, limit: 10, total: 13, pages: 2 });
    expect(p1.body.leads.slice(0, 3).map((l) => l.value)).toEqual([800000, 12000, 11000]);
    const p2 = await rohit.get(`${PP}/leads?page=2&limit=10&sort=-value`);
    expect(p2.body.leads.map((l) => l.value)).toEqual([3000, 2000, 1000]);

    const asc = await rohit.get(`${PP}/leads?page=1&limit=25&sort=company`);
    expect(asc.body.leads[0].company).toBe('Batch 01');
    const notAllowed = await rohit.get(`${PP}/leads?page=1&sort=owner`); // falls back to -updatedAt
    expect(notAllowed.status).toBe(200);

    expect((await rohit.get(`${PP}/leads?q=pune`)).body.leads.map((l) => l.company)).toEqual(['Batch 07']);
    expect((await rohit.get(`${PP}/leads?q=${encodeURIComponent('batch (')}`)).body.leads).toEqual([]); // regex-escaped
    expect((await rohit.get(`${PP}/leads?stage=won`)).body.leads).toHaveLength(4);
    expect((await rohit.get(`${PP}/leads?stage=won,lead&source=LinkedIn`)).body.leads.map((l) => l.company).sort()).toEqual(['Batch 03', 'Batch 09']);
    expect((await rohit.get(`${PP}/leads?priority=Hot`)).body.leads).toHaveLength(2);
  });

  test('admin sees all and can filter by owner; partners cannot', async () => {
    expect((await admin.get(`${PP}/leads`)).body.leads).toHaveLength(14);
    expect((await admin.get(`${PP}/leads?owner=${ids.sana}`)).body.leads).toHaveLength(1);
    expect((await rohit.get(`${PP}/leads?owner=${ids.sana}`)).body.leads).toHaveLength(13);
  });
});

describe('read / edit / delete', () => {
  let lead;
  beforeAll(async () => {
    lead = (await rohit.post(`${PP}/leads`).send({ company: 'Stage Co', value: 100000 })).body.lead;
  });

  test("another partner's lead is 404", async () => {
    expect((await sana.get(`${PP}/leads/${lead._id}`)).body).toEqual({ error: 'Lead not found' });
    expect((await sana.patch(`${PP}/leads/${lead._id}`).send({ company: 'Mine' })).status).toBe(404);
    expect((await sana.delete(`${PP}/leads/${lead._id}`)).status).toBe(404);
    expect((await rohit.get(`${PP}/leads/not-an-id`)).body).toEqual({ error: 'Not found' });
  });

  test('stage moves log activities; lost logs the reason; won logs type won', async () => {
    let res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ stage: 'meeting' });
    expect(res.body.lead.activities[0]).toMatchObject({ type: 'stage', text: 'Moved to Meeting done' });
    res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ stage: 'lost', lostReason: 'Budget' });
    expect(res.body.lead.activities[0]).toMatchObject({ type: 'stage', text: 'Marked lost: Budget' });
    res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ stage: 'won' });
    expect(res.body.lead.activities[0]).toMatchObject({ type: 'won', text: 'Moved to Won' });
    expect((await rohit.patch(`${PP}/leads/${lead._id}`).send({ stage: 'bogus' })).body).toEqual({ error: 'Unknown stage' });
  });

  test('expected close cannot move into the past', async () => {
    const res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ expectedClose: '2001-01-01' });
    expect(res.body).toEqual({ error: "Expected close can't be in the past" });
    expect((await rohit.patch(`${PP}/leads/${lead._id}`).send({ expectedClose: istDay(10) })).body.lead.expectedClose).toBe(istDay(10));
  });

  test('activities and tasks: add, toggle (logs a task activity), remove', async () => {
    let res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ addActivity: { type: 'call', text: 'Spoke with the CTO' } });
    expect(res.body.lead.activities[0]).toMatchObject({ type: 'call', text: 'Spoke with the CTO' });
    expect((await rohit.patch(`${PP}/leads/${lead._id}`).send({ addActivity: { type: 'call', text: '12' } })).status).toBe(400);
    expect((await rohit.patch(`${PP}/leads/${lead._id}`).send({ addTask: { text: 'Send deck', due: '2001-01-01' } })).body.error).toBe("addTask.due: Due date can't be in the past");

    res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ addTask: { text: 'Send deck', due: istDay(2) } });
    const task = res.body.lead.tasks.find((t) => t.text === 'Send deck');
    res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ toggleTask: task._id });
    expect(res.body.lead.tasks.find((t) => t._id === task._id).done).toBe(true);
    expect(res.body.lead.activities[0]).toMatchObject({ type: 'task', text: 'Send deck' });
    res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ removeTask: task._id });
    expect(res.body.lead.tasks.find((t) => t._id === task._id)).toBeUndefined();
  });

  test('only admins reassign, and only to a partner', async () => {
    let res = await rohit.patch(`${PP}/leads/${lead._id}`).send({ owner: ids.sana });
    expect(res.body.lead.owner._id).toBe(ids.rohit);
    expect((await admin.patch(`${PP}/leads/${lead._id}`).send({ owner: ids.admin })).body).toEqual({ error: 'Unknown partner' });
    res = await admin.patch(`${PP}/leads/${lead._id}`).send({ owner: ids.sana });
    expect(res.body.lead.owner._id).toBe(ids.sana);
    expect(res.body.lead.activities[0]).toMatchObject({ type: 'note', text: 'Reassigned to Sana Khan by Mariox' });
    expect((await sana.get(`${PP}/leads/${lead._id}`)).status).toBe(200);
  });

  test('delete', async () => {
    expect((await sana.delete(`${PP}/leads/${lead._id}`)).body).toEqual({ ok: true });
    expect((await admin.get(`${PP}/leads/${lead._id}`)).status).toBe(404);
  });
});
