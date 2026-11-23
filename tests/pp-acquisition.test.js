import { closeDb } from './helpers.js';
import { PP, istDay, ppAgent, ppReset } from './pp-helpers.js';
import { PpAcqLead, PpSetting, PpUser } from '../src/db/models/index.js';

const URL = `${PP}/admin/acquisition`;
let admin;
beforeAll(async () => {
  await ppReset();
  admin = await ppAgent('admin@pp.io');
});
afterAll(closeDb);

const today = istDay(0);
const create = (body) => admin.post(URL).send({ contactedAt: today, today, source: 'LinkedIn', channel: 'WhatsApp', owner: 'Aman', ...body });
const update = (id, body) => admin.patch(`${URL}/${id}`).send({ action: 'update', today, ...body });

describe('add leads', () => {
  test('without a meeting: Lead with next step tomorrow, code P-0001, linkedin gets https', async () => {
    const res = await create({ name: 'Ananya Mehta', company: 'BrightPath', linkedin: 'linkedin.com/in/ananya', phone: '9845011223' });
    expect(res.status).toBe(201);
    expect(res.body.lead).toMatchObject({
      code: 'P-0001', status: 'contacted', next: istDay(1), linkedin: 'https://linkedin.com/in/ananya', phone: '+91 9845011223', country: 'India', temp: 'warm', partner: null,
      steps: [{ k: 'contacted', date: today, note: 'Contacted on WhatsApp' }],
    });
    expect(res.body.lead.createdAt).toBeUndefined();
  });

  test('duplicate name + company → 409 unless force', async () => {
    const dup = await create({ name: 'ananya mehta', company: 'brightpath' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Ananya Mehta is already here (Lead). Save again to add anyway.');
    const forced = await create({ name: 'Ananya Mehta', company: 'BrightPath', force: true });
    expect(forced.body.lead.code).toBe('P-0002');
    await admin.delete(`${URL}/${forced.body.lead._id}`);
  });

  test('with a meeting: starts in Meeting, attendees default to the owner; past slot refused', async () => {
    expect((await create({ name: 'Past Meet', meet: { date: istDay(-1), time: '10:00' } })).body.error).toBe("Date can't be in the past");
    expect((await create({ name: 'Next Past', next: istDay(-3) })).body.error).toBe("Next step can't be in the past");
    const res = await create({ name: 'Rohan Kapoor', company: 'Kapoor Digital', meet: { date: istDay(2), time: '16:00', type: 'Demo' } });
    expect(res.body.lead).toMatchObject({ status: 'meeting', meet: { date: istDay(2), time: '16:00', attendees: ['Aman'], invited: false, duration: 30, type: 'Demo' } });
    expect(res.body.lead.steps.at(-1)).toMatchObject({ k: 'meeting', note: expect.stringMatching(/^Demo on .* 4:00 PM$/) });
  });

  test('GET returns leads newest first, lists, emails and rate', async () => {
    const res = await admin.get(URL);
    expect(res.body.leads.map((l) => l.name)).toEqual(['Rohan Kapoor', 'Ananya Mehta']);
    expect(res.body.lists.team).toEqual(['Ritika', 'Aman', 'Neha', 'Karan']);
    expect(res.body).toMatchObject({ emails: {}, rate: 50 });
  });
});

describe('moves', () => {
  const byName = async (name) => (await admin.get(URL)).body.leads.find((l) => l.name === name);

  test('a step not allowed from the status → 400', async () => {
    const l = await byName('Ananya Mehta');
    expect((await update(l._id, { opt: 'done' })).body).toEqual({ error: 'That step is not available for this lead. Reopen it first.' });
  });

  test('contacted → meet → move (missed) → done → convert → onboard', async () => {
    const l = await byName('Ananya Mehta');
    let res = await update(l._id, { opt: 'meet', meet: { date: istDay(1), time: '11:00', attendees: ['Neha'] }, temp: 'hot' });
    expect(res.body.lead).toMatchObject({ status: 'meeting', temp: 'hot', meet: { date: istDay(1), time: '11:00', invited: false } });
    expect(res.body.needsInvite).toBe(false);

    res = await admin.patch(`${URL}/${l._id}`).send({ action: 'invited' });
    expect(res.body.lead.meet.invited).toBe(true);

    res = await update(l._id, { opt: 'move', meet: { date: istDay(3), time: '12:00' } });
    expect(res.body.lead.steps.at(-1)).toMatchObject({ k: 'moved', missed: true, note: expect.stringMatching(/^Missed: they didn’t join · New meeting /) });
    expect(res.body.lead.meet.invited).toBe(false);

    expect((await update(l._id, { opt: 'done', next: istDay(-2) })).body.error).toBe("Next follow-up can't be in the past");
    res = await update(l._id, { opt: 'done', note: 'Good call' });
    expect(res.body.lead).toMatchObject({ status: 'followup', next: istDay(3) });
    expect(res.body.lead.steps.at(-1)).toMatchObject({ k: 'done', note: 'Good call' });

    expect((await update(l._id, { opt: 'convert' })).body).toEqual({ error: 'Add their email: it is their partner login' });
    expect((await update(l._id, { opt: 'convert', email: 'ananya@bp.in', convertedAt: istDay(5) })).body.error).toBe("Signed on can't be in the future");
    res = await update(l._id, { opt: 'convert', email: 'ananya@bp.in', commissionRate: 0.3 });
    expect(res.body.partner).toMatchObject({ code: 'MX-P-243-4', linked: false, setPasswordUrl: expect.stringMatching(/set-password\?token=/) });
    expect(res.body.lead).toMatchObject({ status: 'converted', convertedAt: today, email: 'ananya@bp.in', partner: { name: 'Ananya Mehta', partnerCode: 'MX-P-243-4', status: 'invited' } });
    expect(res.body.lead.steps.slice(-1)).toEqual([{ k: 'converted', date: today, note: '' }]);
    const user = await PpUser.findOne({ email: 'ananya@bp.in' }).lean();
    expect(user).toMatchObject({ role: 'partner', status: 'invited', source: 'acquisition', commissionRate: 0.3, city: 'India' });

    res = await admin.patch(`${URL}/${l._id}`).send({ action: 'onboard', today });
    expect(res.body.lead).toMatchObject({ status: 'onboarding', onboardAt: today });
    expect((await admin.patch(`${URL}/${l._id}`).send({ action: 'onboard' })).body).toEqual({ error: 'Only converted leads can start onboarding' });
  });

  test('convert links an existing partner; an admin email → 409', async () => {
    const l = await byName('Rohan Kapoor');
    expect((await update(l._id, { opt: 'convert', email: 'admin@pp.io' })).status).toBe(409);
    expect((await PpAcqLead.findById(l._id).lean()).status).toBe('meeting'); // nothing changed
    const res = await update(l._id, { opt: 'convert', email: 'rohit@pp.io' });
    expect(res.body.partner).toMatchObject({ code: 'MX-P-243-1', linked: true, setPasswordUrl: null });
    expect(res.body.lead.steps.map((s) => s.k).slice(-2)).toEqual(['done', 'converted']);
  });

  test('reject needs a reason; reopen goes back to follow-up after a held meeting', async () => {
    const l = (await create({ name: 'Kiran Shah', company: 'Shah Ventures' })).body.lead;
    expect((await update(l._id, { opt: 'reject' })).body).toEqual({ error: 'Pick a reason. It shows in “Why rejected”' });
    let res = await update(l._id, { opt: 'reject', reason: 'Not interested' });
    expect(res.body.lead).toMatchObject({ status: 'rejected', reason: 'Not interested', rejectedAt: today, next: '' });
    res = await admin.patch(`${URL}/${l._id}`).send({ action: 'reopen', today });
    expect(res.body.lead).toMatchObject({ status: 'contacted', next: istDay(1), reason: '' });
    expect(res.body.lead.steps.at(-1)).toEqual({ k: 'followup', date: today, note: 'Reopened' });
    res = await update(l._id, { opt: 'later', note: 'Busy this month' });
    expect(res.body.lead).toMatchObject({ status: 'contacted', next: istDay(3) });
  });

  test('edit, temp, notes; edit with a meeting moves to Meeting and needs an invite', async () => {
    const l = await byName('Kiran Shah');
    expect((await admin.patch(`${URL}/${l._id}`).send({ action: 'temp', temp: 'cold' })).body.lead.temp).toBe('cold');
    expect((await admin.patch(`${URL}/${l._id}`).send({ action: 'notes', notes: 'Call after Diwali' })).body.lead.notes).toBe('Call after Diwali');
    expect((await admin.patch(`${URL}/${l._id}`).send({ action: 'bogus' })).status).toBe(400);
    const lead = { name: 'Kiran Shah', company: 'Shah Ventures', contactedAt: istDay(-2), country: 'UAE', city: 'Dubai', owner: 'Neha' };
    const res = await admin.patch(`${URL}/${l._id}`).send({ action: 'edit', today, lead, meet: { date: istDay(4), time: '10:30' } });
    expect(res.body.needsInvite).toBe(true);
    expect(res.body.lead).toMatchObject({ status: 'meeting', country: 'UAE', meet: { date: istDay(4), attendees: ['Neha'] } });
    expect(res.body.lead.steps[0].date).toBe(istDay(-2));
  });

  test('unknown lead → 404; delete', async () => {
    expect((await admin.patch(`${URL}/64b000000000000000000000`).send({ action: 'invited' })).body).toEqual({ error: 'Lead not found' });
    const l = await byName('Kiran Shah');
    expect((await admin.delete(`${URL}/${l._id}`)).body).toEqual({ ok: true });
  });
});

describe('settings, sample data, import', () => {
  test('lists and team emails are saved separately', async () => {
    let res = await admin.put(`${URL}/settings`).send({ lists: { team: [' Ritika ', 'Ritika', 'Zoya'], sources: ['LinkedIn'], channels: ['Call'], reasons: ['Other'], services: ['IT consulting'], countries: ['India'] } });
    expect(res.body).toEqual({ lists: { team: ['Ritika', 'Zoya'], sources: ['LinkedIn'], channels: ['Call'], reasons: ['Other'], services: ['IT consulting'], countries: ['India'] } });
    res = await admin.put(`${URL}/settings`).send({ emails: { Zoya: 'ZOYA@Mariox.in', Ritika: '' } });
    expect(res.body).toEqual({ emails: { Zoya: 'zoya@mariox.in' } });
    const got = await admin.get(URL);
    expect(got.body.lists.team).toEqual(['Ritika', 'Zoya']);
    expect(got.body.emails).toEqual({ Zoya: 'zoya@mariox.in' });
    expect((await admin.put(`${URL}/settings`).send({ lists: { team: [], sources: ['a'], channels: ['a'], reasons: ['a'], services: ['a'], countries: ['a'] } })).body.error).toBe('lists.team: Keep at least one');
    expect((await admin.put(`${URL}/settings`).send({ emails: { Zoya: 'bad' } })).status).toBe(400);
    // Pipeline settings in the same document are untouched.
    expect((await PpSetting.findOne({ key: 'portal' }).lean()).acquisition.team).toEqual(['Ritika', 'Zoya']);
  });

  test('sample load is idempotent; clear removes only samples', async () => {
    expect((await admin.post(`${URL}/sample`).send({ action: 'load', today })).body).toEqual({ added: 13 });
    expect((await admin.post(`${URL}/sample`).send({ action: 'load', today })).body).toEqual({ added: 0 });
    const real = await PpAcqLead.countDocuments({ sample: { $ne: true } });
    expect((await admin.post(`${URL}/sample`).send({ action: 'clear' })).body).toEqual({ removed: 13 });
    expect(await PpAcqLead.countDocuments()).toBe(real);
  });

  test('import: invalid rows reported, duplicates skipped, meeting rows start in Meeting', async () => {
    const res = await admin.post(`${URL}/import`).send({
      today,
      rows: [
        { name: 'Meera Iyer', company: 'Iyer Ventures', phone: '9920044110', mdate: istDay(2), mtime: '10:00', mlink: 'https://meet.google.com/x' },
        { name: 'Meera Iyer', company: 'iyer ventures' },
        { name: 'Rohan Kapoor', company: 'Kapoor Digital' },
        { name: '1234', company: 'Bad Row' },
        { name: 'Plain Lead' },
      ],
    });
    expect(res.body).toEqual({ imported: 2, skipped: 2, invalid: ['Row 5 (1234): Use letters only (2–80), e.g. Rahul Sharma'], invalidCount: 1 });
    const meera = await PpAcqLead.findOne({ name: 'Meera Iyer' }).lean();
    expect(meera).toMatchObject({ status: 'meeting', owner: 'Ritika', source: 'LinkedIn', phone: '+91 9920044110', meet: { date: istDay(2), link: 'https://meet.google.com/x' }, next: '' });
    const plain = await PpAcqLead.findOne({ name: 'Plain Lead' }).lean();
    expect(plain).toMatchObject({ status: 'contacted', next: istDay(1), country: 'India', contactedAt: today });
    expect(Number(plain.code.slice(2))).toBe(Number(meera.code.slice(2)) + 1);
  });
});
