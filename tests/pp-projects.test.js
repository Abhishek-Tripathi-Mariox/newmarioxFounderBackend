import { closeDb } from './helpers.js';
import { PP, ppAgent, ppReset } from './pp-helpers.js';
import { PpProject, PpUser } from '../src/db/models/index.js';
import { commissionState, projectRate } from '../src/modules/partners/lib/metrics.js';

let ids;
let admin;
let rohit;
let sana;
beforeAll(async () => {
  ids = await ppReset();
  [admin, rohit, sana] = await Promise.all([ppAgent('admin@pp.io'), ppAgent('rohit@pp.io'), ppAgent('sana@pp.io')]);
});
afterAll(closeDb);

const payments = [
  { label: 'Advance payment', amount: 200000, due: '2026-01-10', status: 'received', releasedAt: '2026-01-20', utr: 'UTR123456' },
  { label: 'Design sign-off', amount: 300000, due: '2026-02-10', status: 'received' },
  { label: 'Beta release', amount: 300000, due: '2026-03-10', status: 'due' },
  { label: 'Go-live', amount: 200000, due: '2026-04-10' },
];

describe('commission rate lock', () => {
  test("a new project locks the partner's current rate", async () => {
    const res = await admin.post(`${PP}/projects`).send({ owner: ids.sana, client: 'Acme Retail', title: 'Retail app', deal: 1000000, payments });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ owner: ids.sana, commissionRate: 0.4, deal: 1000000, stage: 0 });
    expect(res.body.project.payments[3].status).toBe('upcoming');

    // Changing the partner's rate later never rewrites the locked one.
    await PpUser.updateOne({ _id: ids.sana }, { commissionRate: 0.6 });
    const again = await admin.get(`${PP}/projects/${res.body.project._id}`);
    expect(again.body.project.commissionRate).toBe(0.4);
  });

  test('an explicit rate wins; unknown partner falls back to 50 %', async () => {
    const own = await admin.post(`${PP}/projects`).send({ owner: ids.rohit, client: 'Beta Co', title: 'Web portal', deal: 500000, commissionRate: 0.25 });
    expect(own.body.project.commissionRate).toBe(0.25);
    const fallback = await admin.post(`${PP}/projects`).send({ owner: '64b000000000000000000000', client: 'Gamma Co', title: 'Gamma site' });
    expect(fallback.body.project.commissionRate).toBe(0.5);
    await PpProject.deleteOne({ _id: fallback.body.project._id });
  });

  test('commission states and rate rule', () => {
    expect(payments.map(commissionState)).toEqual(['released', 'processing', 'due', 'upcoming']);
    expect(projectRate({ commissionRate: 0.3, owner: { commissionRate: 0.6 } }, 0.5)).toBe(0.3);
    expect(projectRate({ owner: { commissionRate: 0.6 } }, 0.5)).toBe(0.6);
    expect(projectRate({ owner: 'x' }, 0.5)).toBe(0.5);
  });
});

describe('validation and payout fields', () => {
  test('rejects bad UTR, rate > 1, stage > 4, missing client', async () => {
    const base = { owner: ids.rohit, client: 'Delta Co', title: 'Delta app' };
    expect((await admin.post(`${PP}/projects`).send({ ...base, payments: [{ label: 'Advance', amount: 10, status: 'received', utr: '12' }] })).body.error)
      .toBe('payments.0.utr: UTR is 6–30 letters or digits');
    expect((await admin.post(`${PP}/projects`).send({ ...base, commissionRate: 1.5 })).status).toBe(400);
    expect((await admin.post(`${PP}/projects`).send({ ...base, stage: 5 })).status).toBe(400);
    expect((await admin.post(`${PP}/projects`).send({ owner: ids.rohit, title: 'No client' })).body.error).toBe('client: Invalid input: expected string, received undefined');
  });

  test('release a payout: received + releasedAt + UTR', async () => {
    const p = (await admin.post(`${PP}/projects`).send({ owner: ids.rohit, client: 'Payout Co', title: 'Payout app', deal: 100000, payments: [{ label: 'Advance', amount: 100000, status: 'due' }] })).body.project;
    const res = await admin.patch(`${PP}/projects/${p._id}`).send({ stage: 2, payments: [{ ...p.payments[0], status: 'received', releasedAt: '2026-11-01', utr: 'HDFC12345678' }] });
    expect(res.status).toBe(200);
    expect(res.body.project.stage).toBe(2);
    expect(commissionState(res.body.project.payments[0])).toBe('released');
    expect((await admin.patch(`${PP}/projects/64b000000000000000000000`).send({ stage: 1 })).body).toEqual({ error: 'Project not found' });
  });
});

describe('reading and scope', () => {
  test('partners list their own projects; list protocol', async () => {
    const mine = await rohit.get(`${PP}/projects`);
    expect(mine.body.projects.every((p) => p.owner._id === ids.rohit)).toBe(true);
    expect(mine.body.projects[0].owner).toMatchObject({ name: 'Rohit Sharma', commissionRate: 0.5 });
    expect((await sana.get(`${PP}/projects`)).body.projects.map((p) => p.client)).toEqual(['Acme Retail']);

    const paged = await admin.get(`${PP}/projects?page=1&limit=10&sort=-deal`);
    expect(paged.body.meta).toEqual({ page: 1, limit: 10, total: 3, pages: 1 });
    expect(paged.body.projects.map((p) => p.deal)).toEqual([1000000, 500000, 100000]);
    expect((await admin.get(`${PP}/projects?stage=2`)).body.projects.map((p) => p.client)).toEqual(['Payout Co']);
    expect((await admin.get(`${PP}/projects?owner=${ids.sana}`)).body.projects).toHaveLength(1);
    expect((await admin.get(`${PP}/projects?q=portal`)).body.projects.map((p) => p.client)).toEqual(['Beta Co']);
  });

  test("another partner's project is 404; partners cannot write", async () => {
    const theirs = (await sana.get(`${PP}/projects`)).body.projects[0];
    expect((await rohit.get(`${PP}/projects/${theirs._id}`)).body).toEqual({ error: 'Project not found' });
    expect((await rohit.patch(`${PP}/projects/${theirs._id}`).send({ stage: 1 })).status).toBe(403);
  });

  test('admin deletes a project', async () => {
    const p = (await admin.get(`${PP}/projects?q=Payout`)).body.projects[0];
    expect((await admin.delete(`${PP}/projects/${p._id}`)).body).toEqual({ ok: true });
    expect(await PpProject.countDocuments({ _id: p._id })).toBe(0);
  });
});
