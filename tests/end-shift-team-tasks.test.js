import { ActivityFeed, AttendanceEvent, Role, ShiftReport, TeamTask, TeamTaskEvent, TimeLog, User } from '../src/db/models/index.js';
import { resetDb, as, closeDb, clearTokens } from './helpers.js';
import { ymd, HOUR } from '../src/modules/workday/time.js';

const W = '/api/v1/workday';
const TT = '/api/v1/team-tasks';

/** Move all of a person's events today back by `ms` (keeps their order). */
const backdateDay = (pid, ms) => AttendanceEvent.updateMany({ person_id: pid }, [{ $set: { at: { $subtract: ['$at', ms] } } }]);
const shift = Math.min(3 * HOUR, Date.now() - new Date().setHours(0, 0, 0, 0) - 2000);

let pm; let dev; let qa;
let tProject; let tPlain; let tLeft; let tOther; let tTheirs;

beforeAll(async () => {
  clearTokens();
  await resetDb();
  // mj (PM) → vg (dev).
  await User.updateMany({ id: 'u-vg' }, { reports_to: 'u-mj' });
  pm = await as('pm@test.io');
  dev = await as('dev@test.io');
  qa = await as('qa@test.io');
  const give = async (b) => (await pm.post(TT).send(b)).body.data.id;
  tProject = await give({ title: 'Wire the payments SDK', projectId: 'PR-101', assigneeId: 'u-vg', status: 'In progress' });
  tPlain = await give({ title: 'Update the onboarding doc', assigneeId: 'u-vg' });
  tLeft = await give({ title: 'Clean up old branches', assigneeId: 'u-vg' });
  tOther = await give({ title: 'PM own task', assigneeId: 'u-mj' }); // vg can't see it
  tTheirs = (await qa.post(TT).send({ title: 'QA checklist', assigneeId: 'u-dn' })).body.data.id;
  await dev.post(`${W}/check-in`);
  await backdateDay('vg', shift);
});
afterAll(closeDb);

describe('end-of-shift report with team tasks', () => {
  test('the form lists my open team tasks (not ones I can’t see)', async () => {
    const f = (await dev.get(`${W}/end-shift`)).body.data;
    expect(f.teamTasksEnabled).toBe(true);
    const ids = f.teamTasks.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([tProject, tPlain, tLeft]));
    expect(ids).not.toContain(tOther);
    expect(f.teamTaskOptions.map((x) => x.id)).not.toContain(tTheirs);
    const p = f.teamTasks.find((x) => x.id === tProject);
    expect(p).toMatchObject({ title: 'Wire the payments SDK', projectId: 'PR-101', projectName: 'Alpha App', done: false, h: '', mine: true });
  });

  test('a task they can’t see or no longer exists is refused before anything is written', async () => {
    let r = await dev.post(`${W}/end-shift`).send({ done: 'x', teamTaskRows: [{ id: tOther, done: true, h: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(`Team task ${tOther} isn’t available any more — remove it from the report.`);
    r = await dev.post(`${W}/end-shift`).send({ done: 'x', teamTaskRows: [{ id: 'TT99999', done: true, h: 1 }] });
    expect(r.status).toBe(422);
    expect(await ShiftReport.countDocuments({ person_id: 'vg' })).toBe(0);
    expect((await dev.get(`${W}/me`)).body.data.checkedIn).toBe(true);
  });

  test('a task they can see but may not complete is refused', async () => {
    // vg created a task for himself's report-to chain? No: make a task vg gave (visible as creator), then drop Edit from the role.
    await TeamTask.insertMany([{ id: 'TT900', title: 'Given by vg', assignee_id: 'u-dn', created_by: 'u-vg', status: 'To do' }]);
    await Role.updateOne({ id: 'r-tm' }, { 'perms.tt.e': false });
    clearTokens();
    const d = await as('dev@test.io');
    const r = await d.post(`${W}/end-shift`).send({ done: 'x', teamTaskRows: [{ id: 'TT900', done: true, h: 0.5 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('You can’t mark “Given by vg” as done.');
    await Role.updateOne({ id: 'r-tm' }, { 'perms.tt.e': true });
    await TeamTask.deleteOne({ id: 'TT900' });
    clearTokens();
    dev = await as('dev@test.io');
  });

  test('team task hours count against time worked', async () => {
    const r = await dev.post(`${W}/end-shift`).send({ done: 'x', rows: [{ p: 'PR-101', h: 0.5 }], teamTaskRows: [{ id: tPlain, done: true, h: 20 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/^Logged 20\.5h but you worked/);
  });

  test('submit: ticked tasks are Done, hours go to the project timesheet / internal work, report keeps them', async () => {
    const r = await dev.post(`${W}/end-shift`).send({
      done: '', rows: [{ p: '', h: '' }],
      teamTaskRows: [
        { id: tProject, done: true, h: 1, note: 'SDK live on staging' },
        { id: tPlain, done: 'true', h: '0.5', note: '' },
        { id: tLeft, done: false, h: 0.25, note: 'Half the branches gone' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.message).toBe('Report submitted · shift ended · 2 team tasks done');
    const day = ymd(Date.now());

    // Tasks: two Done (with a timeline entry from the report), one still open with a progress entry.
    const tasks = Object.fromEntries((await TeamTask.find({ id: { $in: [tProject, tPlain, tLeft] } }).rows()).map((t) => [t.id, t]));
    expect(tasks[tProject].status).toBe('Done');
    expect(tasks[tProject].done_at).toBeTruthy();
    expect(tasks[tPlain].status).toBe('Done');
    expect(tasks[tLeft].status).toBe('To do');
    const act = (await dev.get(`${TT}/${tProject}/activity`)).body.data;
    expect(act.at(-1)).toMatchObject({ kind: 'status', from: 'In progress', to: 'Done', text: 'SDK live on staging', by: 'u-vg' });
    expect(act.at(-1).meta).toMatchObject({ via: 'shift-report', day, hours: 1 });
    const left = (await dev.get(`${TT}/${tLeft}/activity`)).body.data.at(-1);
    expect(left).toMatchObject({ kind: 'shift-report', text: 'Half the branches gone' });
    expect(left.meta).toMatchObject({ via: 'shift-report', hours: 0.25, done: false });

    // Time: the project-linked task → a PR-101 time log on the current milestone; the others → internal work.
    const logs = await TimeLog.find({ member_id: 'vg', day }).rows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ project_id: 'PR-101', milestone_id: 'PR-101-M2', hours: 1, source: 'shift-report', note: `Team task ${tProject}: Wire the payments SDK — SDK live on staging` });
    const rep = await ShiftReport.findOne({ person_id: 'vg', day }).rows();
    expect(rep.done).toBe('Completed team tasks: Wire the payments SDK; Update the onboarding doc');
    expect(rep.internal_rows).toEqual([
      { cat: 'Team task', h: 0.5, note: `Team task ${tPlain}: Update the onboarding doc`, tt: tPlain },
      { cat: 'Team task', h: 0.25, note: `Team task ${tLeft}: Clean up old branches — Half the branches gone`, tt: tLeft },
    ]);
    expect(rep.team_tasks).toEqual([
      { id: tProject, title: 'Wire the payments SDK', done: true, was: 'In progress', h: 1, note: 'SDK live on staging', p: 'PR-101', to: 'timesheet' },
      { id: tPlain, title: 'Update the onboarding doc', done: true, was: 'To do', h: 0.5, note: '', p: null, to: 'internal' },
      { id: tLeft, title: 'Clean up old branches', done: false, was: 'To do', h: 0.25, note: 'Half the branches gone', p: null, to: 'internal' },
    ]);
    expect(r.body.data.report.teamTasks).toHaveLength(3);

    // Live feed + checked out.
    expect((await ActivityFeed.find({ person_id: 'vg', kind: 'task' }).rows()).map((x) => x.text).sort())
      .toEqual(['Completed team task · Update the onboarding doc', 'Completed team task · Wire the payments SDK']);
    expect((await dev.get(`${W}/me`)).body.data.status).toBe('Checked out');

    // Shown wherever reports are read: /shift-reports (Attendance / Reports) and the server attendance view.
    const ceo = await as('ceo@test.io');
    const dto = (await ceo.get('/api/v1/shift-reports')).body.data.find((x) => x.who === 'vg' && x.d === day);
    expect(dto.teamTasks).toEqual([
      { id: tProject, title: 'Wire the payments SDK', done: true, h: 1, note: 'SDK live on staging', p: 'PR-101', to: 'timesheet' },
      { id: tPlain, title: 'Update the onboarding doc', done: true, h: 0.5, note: '', p: null, to: 'internal' },
      { id: tLeft, title: 'Clean up old branches', done: false, h: 0.25, note: 'Half the branches gone', p: null, to: 'internal' },
    ]);
    expect(dto.rows[0]).toMatchObject({ p: 'PR-101', tt: tProject });
    expect(dto.internal.map((x) => x.tt)).toEqual([tPlain, tLeft]);
    const att = (await ceo.get('/api/v1/attendance').query({ range: 'today', person: 'vg' })).body.data;
    const lines = (att.rows || []).flatMap((x) => x.report || []);
    expect(lines.find((x) => x.k === 'Team tasks').v).toBe('✓ Wire the payments SDK 1h (SDK live on staging) · ✓ Update the onboarding doc 0.5h · Clean up old branches 0.25h (Half the branches gone)');

    // Timesheet cap: internal hours from the report count as already logged for that day.
    const tasksDone = (await dev.get(TT)).body.data.filter((x) => x.status === 'Done').map((x) => x.id);
    expect(tasksDone).toEqual(expect.arrayContaining([tProject, tPlain]));
  });

  test('submitting twice changes nothing more (no duplicate time, events or feed lines)', async () => {
    const before = await TeamTaskEvent.countDocuments({});
    // The same body again (a double click that got through): accepted, nothing new is written.
    const r2 = await dev.post(`${W}/end-shift`).send({
      done: '', teamTaskRows: [{ id: tProject, done: true, h: 1, note: 'SDK live on staging' }, { id: tPlain, done: true, h: 0.5 }, { id: tLeft, h: 0.25, note: 'Half the branches gone' }],
    });
    expect(r2.status).toBe(200);
    expect(r2.body.data.message).toBe('Report submitted · shift ended');
    expect(await TeamTaskEvent.countDocuments({})).toBe(before);
    expect(await TimeLog.countDocuments({ member_id: 'vg', day: ymd(Date.now()) })).toBe(1);
    expect(await ShiftReport.countDocuments({ person_id: 'vg' })).toBe(1);
    expect(await ActivityFeed.countDocuments({ person_id: 'vg', kind: 'task' })).toBe(2);
  });

  test('the form after completing shows today’s done tasks as done', async () => {
    const f = (await dev.get(`${W}/end-shift`)).body.data;
    const p = f.teamTasks.find((x) => x.id === tProject);
    expect(p).toMatchObject({ status: 'Done', done: true, doneToday: true });
  });

  test('people without Team tasks access get no section and can still end their shift', async () => {
    await Role.updateOne({ id: 'r-qa' }, { 'perms.tt.v': false });
    clearTokens();
    const q = await as('qa@test.io');
    const f = (await q.get(`${W}/end-shift`)).body.data;
    expect(f).toMatchObject({ teamTasksEnabled: false, teamTasks: [], teamTaskOptions: [] });
    const r = await q.post(`${W}/end-shift`).send({ done: 'x', teamTaskRows: [{ id: tTheirs, done: true }] });
    expect(r.status).toBe(403);
    await Role.updateOne({ id: 'r-qa' }, { 'perms.tt.v': true });
    clearTokens();
  });

  test('sales: team task hours are internal work even when the task names a project', async () => {
    const sm = await as('sm@test.io');
    const own = await sm.post(TT).send({ title: 'Pitch deck for Alpha', assigneeId: (await sm.get('/api/v1/auth/me')).body.data.id });
    expect(own.status).toBe(201);
    await TeamTask.updateOne({ id: own.body.data.id }, { project_id: 'PR-101' });
    await sm.post(`${W}/check-in`);
    await backdateDay('ak', shift);
    const r = await sm.post(`${W}/end-shift`).send({ outcome: 'Calls', teamTaskRows: [{ id: own.body.data.id, done: true, h: 0.5 }] });
    expect(r.status).toBe(200);
    expect(r.body.data.message).toBe('Report submitted · shift ended · 1 team task done');
    expect(r.body.data.report.internal).toEqual([{ cat: 'Team task', h: 0.5, note: `Team task ${own.body.data.id}: Pitch deck for Alpha`, tt: own.body.data.id }]);
    expect(await TimeLog.countDocuments({ member_id: 'ak' })).toBe(0);
    expect((await TeamTask.findOne({ id: own.body.data.id }).rows()).status).toBe('Done');
  });
});
