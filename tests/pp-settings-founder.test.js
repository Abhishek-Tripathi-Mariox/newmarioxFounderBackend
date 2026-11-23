import request from 'supertest';
import { app, closeDb } from './helpers.js';
import { PP, istDay, ppAgent, ppReset } from './pp-helpers.js';
import { PpAcqLead, PpBooking, PpLead, PpProject, PpScope, PpTicket, PpUser } from '../src/db/models/index.js';
import { config } from '../src/config/index.js';
import { partnersSummary } from '../src/modules/partners/founder-summary/founder-summary.service.js';

let ids;
let admin;
let rohit;
beforeAll(async () => {
  ids = await ppReset();
  [admin, rohit] = await Promise.all([ppAgent('admin@pp.io'), ppAgent('rohit@pp.io')]);
});
afterAll(closeDb);

describe('settings', () => {
  const pipeline = {
    stages: [{ key: 'lead', name: 'Lead', prob: 10 }, { name: 'Demo booked', prob: 50 }, { name: 'Demo booked', prob: 60 }],
    sources: [' Referral ', 'Referral', 'Event'],
    priorities: [{ name: 'Hot', tone: 'fire' }],
    lostReasons: ['Budget'],
  };

  test('GET returns defaults for every signed-in user', async () => {
    const res = await rohit.get(`${PP}/settings`);
    expect(res.body.settings.contacts).toEqual([]);
    expect(res.body.settings.announcement).toBe('');
    expect(res.body.settings.pipeline.stages.map((s) => s.key)).toEqual(['lead', 'contacted', 'meeting', 'proposal', 'negotiation']);
  });

  test('PUT: slug keys de-duplicated, lists trimmed, contacts validated', async () => {
    const res = await admin.put(`${PP}/settings`).send({ announcement: 'Hello partners', pipeline, contacts: [{ title: 'Founder office', name: 'Bhanu Pratap', phone: '9876543210', email: 'bhanu@mariox.in' }] });
    expect(res.status).toBe(200);
    expect(res.body.settings.pipeline.stages.map((s) => s.key)).toEqual(['lead', 'demo-booked', 'demo-booked-2']);
    expect(res.body.settings.pipeline.sources).toEqual(['Referral', 'Event']);
    expect(res.body.settings.contacts[0].phone).toBe('+91 9876543210');
    expect(res.body.settings.announcement).toBe('Hello partners');
    expect((await admin.put(`${PP}/settings`).send({ pipeline: { ...pipeline, sources: [] } })).status).toBe(400);
  });

  test('removing a stage that still has leads → 409', async () => {
    await PpLead.create({ owner: ids.rohit, company: 'Stuck Co', stage: 'demo-booked-2', value: 5000 });
    const res = await admin.put(`${PP}/settings`).send({ pipeline: { ...pipeline, stages: [{ key: 'lead', name: 'Lead', prob: 10 }] } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('1 lead(s) are still in a stage you removed. Move them first.');
  });
});

describe('founder summary', () => {
  const URL = `${PP}/founder/summary`;

  test('key guard: missing / wrong → 401', async () => {
    expect((await request(app).get(URL)).body).toEqual({ error: 'Invalid founder key' });
    expect((await request(app).get(URL).set('x-founder-key', 'wrong')).status).toBe(401);
    expect((await rohit.get(URL)).status).toBe(401); // a partner session is not the key
  });

  test('right key → { data } with no-store; same as the in-process function', async () => {
    await PpProject.create({
      owner: ids.rohit, client: 'Acme', title: 'App', deal: 100000, stage: 1, commissionRate: 0.5,
      payments: [{ label: 'Advance', amount: 40000, status: 'received' }, { label: 'Final', amount: 60000, status: 'due', due: '2026-12-01' }],
    });
    await PpTicket.create({ owner: ids.rohit, code: 'TK-2001', subject: 'Payout question here', status: 'requested', escalate: true });
    await PpAcqLead.create({ code: 'P-0001', name: 'Real Lead', contactedAt: new Date().toISOString().slice(0, 10), status: 'converted', owner: 'Aman' });
    await PpAcqLead.create({ code: 'P-S01', name: 'Sample', contactedAt: '2026-01-01', status: 'converted', sample: true });

    const res = await request(app).get(URL).set('x-founder-key', config.founderApiKey);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.body.data;
    expect(d).toMatchObject({ company: 'partners', rate: 0.5, counts: { total: 3, active: 2, invited: 0, disabled: 1 } });
    expect(d.pipeline.stages.find((s) => s.key === 'demo-booked-2')).toMatchObject({ count: 1, value: 5000 });
    expect(d.commission.toPay).toEqual([expect.objectContaining({ partner: 'Rohit Sharma', code: 'MX-P-243-1', amount: 40000, commission: 20000 })]);
    expect(d.commission.clientDue[0]).toMatchObject({ commission: 30000 });
    expect(d.requests).toEqual([expect.objectContaining({ kind: 'ticket', title: 'TK-2001 · Payout question here', escalated: true, partner: 'Sharma Digital' })]);
    expect(d.delivery).toMatchObject({ projects: 1, stages: [{ name: 'Discovery', count: 0 }, { name: 'UI/UX design', count: 1 }, expect.anything(), expect.anything(), expect.anything()] });
    expect(d.attention.signedNotOnboarding).toBe(1); // sample leads excluded
    expect(d.weekly).toHaveLength(12);

    const direct = await partnersSummary();
    expect({ ...direct, syncedAt: null }).toEqual({ ...d, syncedAt: null });
  });

  test('detail lists: roster, new leads, requests by kind, payouts due / on hold, recruitment agenda', async () => {
    // Sana has her payout details; Rohit (from the test above) does not.
    await PpUser.updateOne({ _id: ids.sana }, { pan: 'ABCDE1234F', bankAccount: '1234567890', ifsc: 'HDFC0000001' });
    await PpLead.create({ owner: ids.sana, company: 'Won Co', stage: 'won', value: 100000, activities: [{ type: 'won', text: 'Won' }] });
    await PpProject.create({
      owner: ids.sana, client: 'Beta', title: 'Portal', stage: 2, commissionRate: 0.4,
      payments: [{ label: 'Milestone 1', amount: 50000, status: 'received', due: istDay(-3) }, { label: 'Advance', amount: 10000, status: 'received', releasedAt: istDay(-10), utr: 'U1' }],
    });
    await PpScope.create({ owner: ids.sana, client: 'Beta', project: 'Portal v2', lines: [{ name: 'API', amount: 1000 }], submitted: 1000 });
    await PpBooking.create({ owner: ids.rohit, client: 'Acme', date: istDay(2), time: '11:00', purpose: 'Demo' });
    await PpAcqLead.create([
      { code: 'P-0002', name: 'Late Follow', contactedAt: istDay(0), status: 'followup', next: istDay(-1), owner: 'Neha' },
      { code: 'P-0003', name: 'Meet Soon', company: 'Soon Co', contactedAt: istDay(0), status: 'meeting', meet: { date: istDay(1), time: '15:00', type: 'Demo' }, owner: 'Aman' },
      { code: 'P-0004', name: 'Far Away', contactedAt: istDay(0), status: 'contacted', next: istDay(12), owner: 'Aman' },
    ]);

    const d = (await request(app).get(URL).set('x-founder-key', config.founderApiKey)).body.data;

    // Roster: every partner (admin excluded), most recent activity first
    expect(d.roster.count).toBe(3);
    const by = Object.fromEntries(d.roster.list.map((r) => [r.name, r]));
    expect(by['Rohit Sharma']).toMatchObject({
      company: 'Sharma Digital', code: 'MX-P-243-1', status: 'active', leads: 1, openLeads: 1, wonLeads: 0, wonValue: 0,
      commissionPayable: 20000, commissionPaid: 0, payoutDetailsMissing: true,
    });
    expect(by['Sana Khan']).toMatchObject({ leads: 1, openLeads: 0, wonLeads: 1, wonValue: 100000, commissionPayable: 20000, commissionPaid: 4000, payoutDetailsMissing: false });
    expect(by['Gone Partner']).toMatchObject({ status: 'disabled', leads: 0, commissionPayable: 0 });
    expect(d.roster.list.at(-1).name).toBe('Gone Partner');

    // New partner leads in the last 7 days, newest first
    expect(d.newLeads).toMatchObject({ count: 2, value: 105000 });
    expect(d.newLeads.list[0]).toMatchObject({ partner: 'Khan Ventures', company: 'Won Co', stage: 'won', stageName: 'Won', value: 100000 });
    expect(d.newLeads.list[1]).toMatchObject({ partner: 'Sharma Digital', company: 'Stuck Co', stage: 'demo-booked-2', stageName: 'Demo booked', value: 5000 });

    // Requests by kind
    expect(d.requestKinds.map((k) => [k.kind, k.open])).toEqual([['scope', 1], ['visit', 1], ['tech', 0], ['ticket', 1]]);
    expect(d.requestKinds[0].latest).toEqual([expect.objectContaining({ title: 'Beta · Portal v2', partner: 'Khan Ventures', status: 'In review' })]);
    expect(d.requestKinds[3]).toMatchObject({ escalated: 1, latest: [expect.objectContaining({ title: 'TK-2001 · Payout question here' })] });

    // Payouts the client has paid for: Sana's is payable, Rohit's waits on his PAN / bank details
    expect(d.payoutsDue.payable).toEqual({
      count: 1, total: 20000,
      list: [{ id: expect.any(String), partner: 'Sana Khan', company: 'Khan Ventures', code: 'MX-P-243-2', client: 'Beta', project: 'Portal', milestone: 'Milestone 1', amount: 50000, commission: 20000, clientPaidOn: expect.any(String) }],
    });
    expect(d.payoutsDue.onHold).toMatchObject({ count: 1, total: 20000 });
    expect(d.payoutsDue.onHold.list[0]).toMatchObject({ partner: 'Rohit Sharma', project: 'App', milestone: 'Advance', reason: 'PAN, bank account, IFSC missing' });

    // Recruitment: overdue follow-up and tomorrow's meeting; the one 12 days out is not on the agenda
    expect(d.recruitment.agenda.list).toEqual([
      expect.objectContaining({ name: 'Late Follow', owner: 'Neha', kind: 'followup', type: 'Follow-up', overdue: true }),
      expect.objectContaining({ name: 'Meet Soon', company: 'Soon Co', kind: 'meeting', type: 'Demo', overdue: false, at: new Date(`${istDay(1)}T15:00:00+05:30`).toISOString() }),
    ]);
    expect(d.recruitment.agenda.count).toBe(2);
    expect(d.recruitment.recent.count).toBe(4); // contacted this month, sample excluded
    expect(d.recruitment.recent.list.map((l) => l.name).sort()).toEqual(['Far Away', 'Late Follow', 'Meet Soon', 'Real Lead']);
  });
});
