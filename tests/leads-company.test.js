/**
 * Leads × Founders HQ: every lead is for one of our companies (`company_id`, like team tasks), and the
 * Founder / Co-founder (users with an HQ seat) get a lead-owner profile so they can own leads and
 * assign them to the sales team — without showing up as sales staff on Live / attendance.
 */
import { Lead, LeadActivity, SalesOwner, User } from '../src/db/models/index.js';
import { createUser as createHqAccount, updateUser as updateHqAccount } from '../src/modules/hq/users/users.service.js';
import { ensureFounderOwner, ensureFounderOwners } from '../src/modules/people/founderOwners.js';
import { people } from '../src/modules/workday/workday.repository.js';
import { resetDb, as, closeDb } from './helpers.js';

const API = '/api/v1';
const newLead = (o = {}) => ({ company: 'Acme Labs', contact: 'Ravi', email: '', phone: '', services: ['Mobile App'], value: 1000, ...o });

beforeAll(async () => { await resetDb(); });
afterAll(closeDb);

describe('lead company', () => {
  test('old leads read as Mariox; create defaults to Mariox and accepts companyId', async () => {
    const ceo = await as('ceo@test.io');
    const old = await ceo.get(`${API}/leads/MX-1001`);
    expect(old.body.data.companyId).toBe('mariox');

    const plain = await ceo.post(`${API}/leads`).send(newLead({ company: 'Plain Co' }));
    expect(plain.status).toBe(201);
    expect(plain.body.data.companyId).toBe('mariox');
    expect((await Lead.findOne({ id: plain.body.data.id }).rows()).company_id).toBe('mariox');

    const hroo = await ceo.post(`${API}/leads`).send(newLead({ company: 'Hroo Client', companyId: 'HROO' }));
    expect(hroo.status).toBe(201);
    expect(hroo.body.data.companyId).toBe('hroo');

    const bad = await ceo.post(`${API}/leads`).send(newLead({ companyId: 'not a slug!' }));
    expect(bad.status).toBe(422);
  });

  test('?company= filters the list (missing company_id counts as Mariox); export too', async () => {
    const ceo = await as('ceo@test.io');
    await Lead.collection.updateOne({ _id: 'MX-1002' }, { $unset: { company_id: '' } }); // a row from before the field existed
    const hroo = await ceo.get(`${API}/leads?company=hroo`);
    expect(hroo.body.data.map((l) => l.company)).toEqual(['Hroo Client']);
    const mariox = await ceo.get(`${API}/leads?company=mariox&pageSize=100`);
    const ids = mariox.body.data.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['MX-1001', 'MX-1002']));
    expect(mariox.body.data.every((l) => l.companyId === 'mariox')).toBe(true);
    const csv = await ceo.get(`${API}/leads/export.csv?company=hroo`);
    expect(csv.status).toBe(200);
    const csvLines = csv.text.trim().split('\n');
    expect(csvLines).toHaveLength(2); // header + the HROO lead
    expect(csvLines[0].trim().endsWith('"Our company"')).toBe(true);
    expect(csvLines[1].trim().endsWith('"HROO"')).toBe(true); // built-ins by name, so the file re-imports
    expect((await ceo.get(`${API}/leads?company=Bad Value`)).status).toBe(422);
  });

  test('changing the company is logged as a lead activity; an unchanged one is not', async () => {
    const ceo = await as('ceo@test.io');
    const res = await ceo.patch(`${API}/leads/MX-1001`).send({ companyId: 'arth' });
    expect(res.status).toBe(200);
    expect(res.body.data.companyId).toBe('arth');
    expect(res.body.data.activities.at(-1)).toMatchObject({ kind: 'company', text: 'Company: Mariox → Arth' });
    await ceo.patch(`${API}/leads/MX-1001`).send({ companyId: 'arth', notes: 'same company' });
    expect(await LeadActivity.countDocuments({ lead_id: 'MX-1001', kind: 'company' })).toBe(1);
    const added = await ceo.patch(`${API}/leads/MX-1001`).send({ companyId: 'acme-labs' });
    expect(added.body.data.activities.at(-1).text).toBe('Company: Arth → Acme labs');
  });

  test('CSV import: optional company column (id or name), default Mariox, unknown values warn', async () => {
    const sm = await as('sm@test.io');
    const row = (o) => ({ company: 'Imp', contact: 'Ravi', email: '', phone: '', services: 'Mobile App', source: '', owner: '', status: '', value: '', notes: '', ...o });
    const res = await sm.post(`${API}/leads/import`).send({
      rows: [
        row({ company: 'Imp Default' }),
        row({ company: 'Imp Hroo', companyId: 'HROO' }),
        row({ company: 'Imp Arth', companyId: 'arth' }),
        row({ company: 'Imp Bad', companyId: '???' }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(4);
    const byName = Object.fromEntries((await Lead.find({ company: /^Imp / }).rows()).map((l) => [l.company, l.company_id]));
    expect(byName).toEqual({ 'Imp Default': 'mariox', 'Imp Hroo': 'hroo', 'Imp Arth': 'arth', 'Imp Bad': 'mariox' });
    expect(res.body.data.warnings).toEqual([expect.objectContaining({ row: 5, warning: expect.stringContaining('Company "???"') })]);
  });
});

describe('founders own leads', () => {
  test('a seat holder gets a founder sales-owner profile on first need, idempotently', async () => {
    await User.updateOne({ id: 'u-ceo' }, { hq_seat: 'rahul' });
    const ceo = await as('ceo@test.io');
    const owners = (await ceo.get(`${API}/sales-owners`)).body.data;
    const me = await User.findOne({ id: 'u-ceo' }).rows();
    expect(me.owner_id).toBeTruthy();
    expect(owners.find((o) => o.id === me.owner_id)).toMatchObject({ name: 'CEO', active: true, founder: true, userId: 'u-ceo' });
    expect(owners.find((o) => o.id === 'ak')).toMatchObject({ founder: false });
    // Running it again changes nothing.
    await ensureFounderOwners();
    expect(await ensureFounderOwner('u-ceo')).toBe(me.owner_id);
    expect(await SalesOwner.countDocuments({ founder: true })).toBe(1);
    // A user without a seat gets nothing.
    expect(await ensureFounderOwner('u-admin')).toBeNull();
  });

  test('the founder keeps their attendance id; founders are not sales staff on Live / attendance', async () => {
    const ceo = await as('ceo@test.io');
    const me = await ceo.get(`${API}/auth/me`);
    const { owner_id: ownerId } = await User.findOne({ id: 'u-ceo' }).rows();
    expect(me.body.data.ownerId ?? me.body.data.user?.ownerId).toBe(ownerId);
    expect(me.body.data.pid ?? me.body.data.user?.pid).toBe('ceo');
    const tracked = await people();
    expect(tracked.some((p) => p.id === ownerId)).toBe(false);
    expect(tracked.some((p) => p.id === 'ak')).toBe(true);
    const live = await ceo.get(`${API}/live`);
    expect(live.status).toBe(200);
    expect(JSON.stringify(live.body.data.people || [])).not.toContain(ownerId);
  });

  test('a founder creates leads for themselves and assigns any lead to a sales owner', async () => {
    const ceo = await as('ceo@test.io');
    const { owner_id: ownerId } = await User.findOne({ id: 'u-ceo' }).rows();
    const mine = await ceo.post(`${API}/leads`).send(newLead({ company: 'Founder Lead', companyId: 'hroo' }));
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ ownerId, ownerName: 'CEO', companyId: 'hroo' });

    const moved = await ceo.patch(`${API}/leads/${mine.body.data.id}/owner`).send({ ownerId: 'ps' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.ownerId).toBe('ps');
    // The sales executive now sees it, with its company.
    const se = await as('se@test.io');
    const seen = (await se.get(`${API}/leads`)).body.data.find((l) => l.id === mine.body.data.id);
    expect(seen).toMatchObject({ companyId: 'hroo', ownerName: 'Priya Sharma' });

    // …and a sales lead can be given to the founder.
    const toFounder = await ceo.patch(`${API}/leads/MX-1002/owner`).send({ ownerId });
    expect(toFounder.body.data.ownerId).toBe(ownerId);
  });

  test('seat assignment in Users & roles creates the profile; renames follow', async () => {
    const ceo = await as('ceo@test.io');
    const created = await ceo.post(`${API}/users`).send({
      name: 'Saswat Sahu', email: 'saswat@test.io', role: 'r-super', dept: 'Management', sendInvite: false, password: 'secret123', hq_seat: 'saswat',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.ownerId).toBeTruthy();
    expect(await SalesOwner.findOne({ id: created.body.data.ownerId }).rows()).toMatchObject({ name: 'Saswat Sahu', founder: true });
    const renamed = await ceo.patch(`${API}/users/${created.body.data.id}`).send({ name: 'Saswat S.' });
    expect(renamed.status).toBe(200);
    expect((await SalesOwner.findOne({ id: created.body.data.ownerId }).rows()).name).toBe('Saswat S.');
  });

  test('Founders HQ Accounts: a new account gets the profile; renaming it renames the profile', async () => {
    // Free the Co-founder seat taken above.
    await User.updateOne({ email: 'saswat@test.io' }, { hq_seat: null });
    const account = await createHqAccount({}, { name: 'Co Founder', email: 'co@test.io', password: 'secret123', seat: 'saswat' });
    const user = await User.findOne({ email: 'co@test.io' }).rows();
    expect(user.owner_id).toBeTruthy();
    expect(await SalesOwner.findOne({ id: user.owner_id }).rows()).toMatchObject({ name: 'Co Founder', founder: true });
    await updateHqAccount(account.id, { name: 'Co Founder Two' });
    expect((await SalesOwner.findOne({ id: user.owner_id }).rows()).name).toBe('Co Founder Two');
  });
});
