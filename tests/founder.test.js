import request from 'supertest';
import { resetDb, app, closeDb } from './helpers.js';
import { ActiveTimer, AttendanceEvent, Bug, ChangeRequest, FollowUp, Lead, LeadActivity, Milestone, Project, Quote, ShiftReport, TeamTask, TimeLog } from '../src/db/models/index.js';
import { config } from '../src/config/index.js';
import { periods } from '../src/modules/founder/founder.service.js';
import { addDays, isSunday } from '../src/modules/workday/time.js';

const URL = '/api/v1/founder/summary';
const KEY = config.founderApiKey;
const DAY = 864e5;
const MIN = 6e4;

const now = Date.now();
const P = periods(now);
const T = P.T;
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Attendance assertions need a few hours of "today" behind us (events are only counted from midnight).
const enoughOfToday = now - T > 3 * 3600e3;

beforeAll(async () => {
  await resetDb();
  const closedAt = new Date(Math.max(T, now - MIN));
  const lead = (id, owner, status, value, extra = {}) => ({ id, company: `Co ${id}`, contact: 'C', owner_id: owner, first_owner_id: owner, status, value, services: [], ...extra });
  await Lead.insertMany([
    lead('MX-3001', 'ak', 'Won', 500000),
    lead('MX-3002', 'ps', 'Lost', 200000),
    // Won long ago with no stage activity: falls back to updated_at, outside every period.
    lead('MX-3003', 'ak', 'Won', 900000, { created_at: new Date(now - 300 * DAY), updated_at: new Date(now - 200 * DAY) }),
  ]);
  await LeadActivity.insertMany([
    { lead_id: 'MX-3001', kind: 'status', text: 'Stage: Proposal Sent → Won', at: closedAt },
    { lead_id: 'MX-3002', kind: 'status', text: 'Stage: Qualified → Lost', at: closedAt },
  ]);
  await FollowUp.insertMany([
    { id: 'F1', type: 'Call', title: 'Overdue', owner_id: 'ps', due_at: new Date(T - DAY) },
    { id: 'F2', type: 'Call', title: 'Done', owner_id: 'ak', due_at: new Date(T - DAY), done: true },
  ]);

  // PR-102's current milestone is 3 days late; PR-101's waits 9 days for client approval.
  await Milestone.updateMany({ id: 'PR-102-M1' }, { due_date: ymd(T - 3 * DAY) });
  await Milestone.updateMany({ id: 'PR-101-M2' }, { due_date: ymd(T + 20 * DAY), approval_status: 'Pending', approval_asked_at: new Date(now - 9 * DAY) });
  // 130 h logged on PR-101 against 260 h of milestone allocation → 50 %.
  await TimeLog.insertMany([24, 24, 24, 24, 24, 10].map((hours, i) => ({ id: `L${i + 1}`, member_id: 'vg', project_id: 'PR-101', day: ymd(T - (i + 1) * DAY), hours })));

  await ChangeRequest.insertMany([{ id: 'CR-101-1', project_id: 'PR-101', n: 1, title: 'Wallet', hours: 10, rate: 12000, amount: 120000, status: 'Sent to client' }]);
  await Bug.insertMany([
    { id: 'BG-1001', project_id: 'PR-101', title: 'Crash on login', dept: 'Mobile', env: 'Production', severity: 'Critical', reporter: 'dn', reported_on: ymd(T - 2 * DAY) },
    { id: 'BG-1002', project_id: 'PR-101', title: 'Typo', dept: 'Web', env: 'Staging', severity: 'Minor', reporter: 'dn', reported_on: ymd(T), status: 'Closed' },
  ]);

  if (enoughOfToday) {
    await AttendanceEvent.insertMany([
      { person_id: 'vg', kind: 'login', at: new Date(now - 30 * MIN) },
      { person_id: 'si', kind: 'login', at: new Date(now - 60 * MIN) },
      { person_id: 'si', kind: 'break', at: new Date(now - 10 * MIN), meta: { type: 'Lunch', planMin: 30 } },
      { person_id: 'dn', kind: 'login', at: new Date(now - 120 * MIN) },
      { person_id: 'dn', kind: 'logout', at: new Date(now - 100 * MIN) },
    ]);
    await ActiveTimer.insertMany([{ person_id: 'vg', project_id: 'PR-101', title: 'Build login', started_at: new Date(now - 20 * MIN) }]);
  }
});
afterAll(async () => { await closeDb(); });

test('reports, quotes, on-hold projects and team tasks', async () => {
  await ShiftReport.insertMany([
    { person_id: 'vg', day: ymd(T), blockers: 'Waiting for the payment gateway keys from the client', done: 'Wallet screens' },
    { person_id: 'si', day: ymd(T), blockers: '' },
    { person_id: 'dn', day: ymd(T - 3 * DAY), blockers: 'Too old to show' },
  ]);
  await Quote.insertMany([
    { id: 'Q-1001-1', lead_id: 'MX-1001', status: 'Sent', items: [], net: 90000, total: 106200, sent_at: new Date(now - 5 * DAY) },
    { id: 'Q-1002-1', lead_id: 'MX-1002', status: 'Viewed', items: [], net: 0, total: 50000, sent_at: new Date(now - 2 * DAY) },
    { id: 'Q-1002-2', lead_id: 'MX-1002', status: 'Draft', items: [], net: 70000, total: 82600 },
    { id: 'Q-3001-1', lead_id: 'MX-3001', status: 'Accepted', items: [], net: 500000, total: 590000, accepted_at: new Date(Math.max(P.monthStart, now - MIN)) },
  ]);
  await Project.insertMany([{
    id: 'PR-103', name: 'Gamma Site', client: 'Gamma Co', status: 'On hold', pm_member_id: 'mj', start_date: ymd(T - 30 * DAY), due_date: ymd(T + 30 * DAY),
    status_reason: 'Client end', status_note: 'Waiting for content', status_note_at: new Date(now - 4 * DAY),
  }]);
  await TeamTask.insertMany([
    { id: 'TT-1', title: 'Send invoice to Alpha', status: 'To do', priority: 'High', due_date: ymd(T - 2 * DAY), assignee_id: 'u-vg', created_by: 'u-ceo' },
    { id: 'TT-2', title: 'Prepare demo', status: 'In progress', due_date: ymd(T + 3 * DAY), assignee_id: 'u-si', created_by: 'u-ceo' },
    { id: 'TT-3', title: 'Done thing', status: 'Done', done_at: new Date(Math.max(P.weekStart, now - MIN)), assignee_id: 'u-dn', created_by: 'u-ceo' },
  ]);

  const d = (await request(app).get(URL).set('x-founder-key', KEY)).body.data;

  expect(d.reports.submitted).toBe(2);
  expect(d.reports.blockers).toEqual([
    expect.objectContaining({ who: 'vg', name: 'Vikas Gupta', text: 'Waiting for the payment gateway keys from the client' }),
  ]);
  expect(d.quotes.waiting).toMatchObject({ count: 2, value: 140000 }); // net when set, else total
  expect(new Date(d.quotes.waiting.oldestSentAt).getTime()).toBeLessThan(now - 4 * DAY);
  expect(d.quotes.acceptedMonth).toEqual({ count: 1, value: 500000 });
  // Waiting quotes, longest waiting first (Draft and Accepted are not waiting)
  expect(d.quotes.waiting.list).toEqual([
    { id: 'Q-1001-1', leadId: 'MX-1001', company: 'Zenvy Retail', status: 'Sent', amount: 90000, total: 106200, sentAt: expect.any(String), viewedAt: null },
    { id: 'Q-1002-1', leadId: 'MX-1002', company: 'Kaveri Foods', status: 'Viewed', amount: 50000, total: 50000, sentAt: expect.any(String), viewedAt: null },
  ]);
  expect(d.projects.running).toBe(2);
  expect(d.projects.onHold).toEqual([
    expect.objectContaining({ id: 'PR-103', name: 'Gamma Site', pm: 'Meera Joshi', reason: 'Client end', note: 'Waiting for content' }),
  ]);
  expect(d.teamTasks).toMatchObject({ open: 2, overdue: 1, doneWeek: 1 });
  expect(d.teamTasks.overdueList).toEqual([expect.objectContaining({ id: 'TT-1', title: 'Send invoice to Alpha', assignee: 'Vikas Gupta', priority: 'High' })]);
});

test('needs the founder key', async () => {
  expect((await request(app).get(URL)).status).toBe(401);
  expect((await request(app).get(URL).set('x-founder-key', 'wrong-key-wrong-key-wrong')).status).toBe(401);
  // A user's bearer token is not enough either.
  expect((await request(app).get(URL).set('Authorization', 'Bearer x')).status).toBe(401);
});

test('mariox summary', async () => {
  const res = await request(app).get(URL).set('x-founder-key', KEY);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  const d = res.body.data;

  expect(d).toMatchObject({ company: 'mariox', cash: null });
  expect(new Date(d.syncedAt).getTime()).toBeGreaterThan(now - 60 * 1000);

  // Sales: won/lost dated by their stage activity
  expect(d.sales.won.today).toEqual({ value: 500000, deals: 1 });
  expect(d.sales.won.month).toMatchObject({ value: 500000, deals: 1 });
  expect(d.sales.won.month).toHaveProperty('prev');
  expect(d.sales.lost.month).toEqual({ value: 200000, deals: 1 });
  expect(d.sales.winRateQuarter).toBe(0.5);
  expect(d.sales.stages.find((s) => s.name === 'New')).toEqual({ key: 'New', name: 'New', count: 1, value: 800000 });
  expect(d.sales.stages.find((s) => s.name === 'Qualified')).toMatchObject({ count: 1, value: 350000 });
  expect(d.sales.stages.some((s) => s.name === 'Won' || s.name === 'Lost')).toBe(false);
  expect(d.sales.owners).toEqual([
    { id: 'ak', name: 'Aman Kapoor', hue: 265, open: 1, value: 800000, wonMonth: 500000, overdue: 0 },
    { id: 'ps', name: 'Priya Sharma', hue: 340, open: 1, value: 350000, wonMonth: 0, overdue: 1 },
  ]);

  // Delivery
  expect(d.changeRequests).toEqual({
    waitingOnClient: 1, value: 120000,
    list: [{ id: 'CR-101-1', projectId: 'PR-101', projectName: 'Alpha App', title: 'Wallet', amount: 120000, sentAt: expect.any(String) }],
  });
  expect(d.bugs.open).toBe(1);
  expect(d.bugs.critical).toEqual([{ id: 'BG-1001', projectId: 'PR-101', projectName: 'Alpha App', title: 'Crash on login', openedAt: expect.any(String) }]);
  expect(d.bugs.bySeverity).toEqual({ Critical: 1, Major: 0, Minor: 0, Trivial: 0 });
  expect(d.projects.running).toBe(2);
  const [first, second] = d.projects.list; // ordered by current milestone due date
  expect(first).toMatchObject({ id: 'PR-102', pm: 'Meera Joshi', milestone: { n: 1, name: 'Discovery & UI/UX' }, approvalAskedAt: null });
  expect(second).toMatchObject({ id: 'PR-101', milestone: { n: 2, name: 'Development · Phase 1' }, hoursUsed: 0.5, hoursLogged: 130, hoursBudget: 260 });
  expect(new Date(second.approvalAskedAt).getTime()).toBeLessThan(now - 8 * DAY);

  // Weekly trend: 12 Monday-based weeks, this week last
  expect(d.weekly).toHaveLength(12);
  expect(new Date(d.weekly[11].weekOf).getTime()).toBe(P.weekStart);
  expect(d.weekly[11].value).toBe(500000);

  // Team: every active member and sales owner
  expect(d.team.size).toBe(7);
  expect(d.team.people.map((p) => p.id).sort()).toEqual(['ak', 'dn', 'km', 'mj', 'ps', 'si', 'vg']);
  if (enoughOfToday) {
    const by = Object.fromEntries(d.team.people.map((p) => [p.id, p]));
    expect(by.vg).toMatchObject({ team: 'Mobile', checkOutAt: null, break: null, timer: { task: 'Build login', projectId: 'PR-101' } });
    expect(by.si.break).toMatchObject({ kind: 'Lunch', plannedMin: 30 });
    expect(by.dn.checkOutAt).toEqual(expect.any(String));
    expect(by.km).toMatchObject({ checkInAt: null, timer: null });
    expect(d.team).toMatchObject({ in: 1, onBreak: 1, left: 1, notIn: 4 });
  }
});

test('team.days: past working days of attendance, newest first, Sundays skipped', async () => {
  const day = [1, 2].map((i) => addDays(T, -i)).find((d) => !isSunday(d));
  const at = (min) => new Date(day + min * MIN);
  await AttendanceEvent.insertMany([
    { person_id: 'km', kind: 'login', at: at(11 * 60) }, // 11:00, after 10:30 → late
    { person_id: 'km', kind: 'break', at: at(13 * 60), meta: { type: 'Lunch', planMin: 30 } },
    { person_id: 'km', kind: 'resume', at: at(13 * 60 + 30) },
    { person_id: 'km', kind: 'logout', at: at(18 * 60) },
  ]);
  const days = (await request(app).get(URL).set('x-founder-key', KEY)).body.data.team.days;
  expect(days.length).toBeGreaterThanOrEqual(5);
  expect(days.some((d) => isSunday(Date.parse(d.day)))).toBe(false);
  expect(Date.parse(days[0].day)).toBeGreaterThan(Date.parse(days[1].day));
  const km = days.find((d) => Date.parse(d.day) === day).people.find((p) => p.id === 'km');
  expect(km).toEqual({
    id: 'km', checkInAt: at(11 * 60).toISOString(), checkOutAt: at(18 * 60).toISOString(),
    late: true, workedMin: 6 * 60 + 30, breakMin: 30, breaks: 1,
  });
});

test('detail lists: follow-ups, new leads, sources, milestones, attendance and hours this week', async () => {
  const dueToday = new Date(T + 23 * 3600e3);
  await FollowUp.insertMany([
    { id: 'F3', type: 'Meeting', title: 'Demo', lead_id: 'MX-1001', owner_id: 'ak', due_at: dueToday },
    { id: 'F4', type: 'Call', title: 'Tomorrow', owner_id: 'ak', due_at: new Date(T + DAY + 3600e3) },
  ]);
  await TimeLog.insertMany([
    { id: 'L20', member_id: 'vg', project_id: 'PR-101', day: ymd(T), hours: 3 },
    { id: 'L21', member_id: 'km', project_id: 'PR-102', day: ymd(T), hours: 2 },
  ]);
  // A full late day for mj on Monday (only when Monday is before today).
  const monday = P.weekStart < T;
  if (monday) {
    await AttendanceEvent.insertMany([
      { person_id: 'mj', kind: 'login', at: new Date(P.weekStart + 11 * 60 * MIN) },
      { person_id: 'mj', kind: 'logout', at: new Date(P.weekStart + 19 * 60 * MIN) },
    ]);
  }

  const d = (await request(app).get(URL).set('x-founder-key', KEY)).body.data;

  // Follow-ups: overdue first, then due today; done and tomorrow's left out
  expect(d.sales.followUps.dueToday).toBe(1);
  expect(d.sales.followUps.due).toMatchObject({ count: 2, overdue: 1 });
  expect(d.sales.followUps.due.list).toEqual([
    expect.objectContaining({ id: 'F1', type: 'Call', company: null, ownerId: 'ps', owner: 'Priya Sharma', overdue: true }),
    expect.objectContaining({ id: 'F3', type: 'Meeting', leadId: 'MX-1001', company: 'Zenvy Retail', owner: 'Aman Kapoor', dueAt: dueToday.toISOString() }),
  ]);

  // New leads (last 7 days) and lead sources this month; MX-3003 is 300 days old
  expect(d.sales.newLeads.count).toBe(4);
  expect(d.sales.newLeads.value).toBe(800000 + 350000 + 500000 + 200000);
  expect(d.sales.newLeads.list.map((l) => l.id).sort()).toEqual(['MX-1001', 'MX-1002', 'MX-3001', 'MX-3002']);
  expect(d.sales.newLeads.list.find((l) => l.id === 'MX-1001')).toEqual({
    id: 'MX-1001', company: 'Zenvy Retail', source: 'Website', ownerId: 'ak', owner: 'Aman Kapoor', hue: 265, value: 800000, stage: 'New', createdAt: expect.any(String),
  });
  expect(d.sales.sourcesMonth).toEqual([{ source: 'Not set', count: 2 }, { source: 'Referral', count: 1 }, { source: 'Website', count: 1 }]);

  // Milestones of running projects: PR-102-M1 is 3 days late; PR-101-M2 is due in 20 days (not this week)
  expect(d.projects.milestones.overdue).toEqual({
    count: 1,
    list: [{
      id: 'PR-102-M1', projectId: 'PR-102', projectName: 'Beta Web', client: 'Beta Health', n: 1, name: 'Discovery & UI/UX',
      status: 'In progress', approvalPending: false, approvalAskedAt: null, due: expect.any(String),
    }],
  });
  expect(d.projects.milestones.dueSoon).toEqual({ count: 0, list: [] });

  // Hours logged this week vs shift hours (8 h × working days so far)
  const h = d.hoursWeek;
  const workdays = h.workdays;
  expect(workdays).toBeGreaterThanOrEqual(1);
  expect(h.expected).toBe(5 * 8 * workdays); // the 5 delivery members; sales owners don't log time
  const hBy = Object.fromEntries(h.people.map((x) => [x.id, x]));
  expect(Object.keys(hBy).sort()).toEqual(['dn', 'km', 'mj', 'si', 'vg']);
  expect(hBy.km).toEqual({ id: 'km', name: 'Karan Malhotra', hue: 70, team: 'Backend', hours: 2, expected: 8 * workdays });
  expect(hBy.vg.hours).toBeGreaterThanOrEqual(3);
  expect(h.projects.list.find((x) => x.id === 'PR-102')).toEqual({ id: 'PR-102', name: 'Beta Web', hours: 2 });
  expect(h.total).toBe(Math.round(h.people.reduce((a, x) => a + x.hours, 0) * 10) / 10);

  // Attendance this week, per person
  const w = d.team.week;
  expect(w.workdays).toBe(workdays);
  expect(w.people).toHaveLength(7);
  const aBy = Object.fromEntries(w.people.map((x) => [x.id, x]));
  expect(aBy.ak).toMatchObject({ daysPresent: 0, lateDays: 0, workedMin: 0, expectedMin: 8 * 60 * workdays });
  if (monday) expect(aBy.mj).toMatchObject({ daysPresent: 1, lateDays: 1, workedMin: 8 * 60 });
  if (enoughOfToday) {
    expect(aBy.dn).toMatchObject({ daysPresent: 1, workedMin: 20 });
    expect(aBy.vg.daysPresent).toBe(1);
  }
});
