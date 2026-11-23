import { tx } from '../../db/mongo.js';
import { Member, Project, ProjectMember, ShiftReport } from '../../db/models/index.js';
import { ilike, TEXT_ORDER } from '../../db/modelKit.js';
import { AppError, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { nextId } from '../../core/ids.js';
import { pageParams, sortParam } from '../../core/http.js';
import { peopleScope, visibleProjectIds } from '../../core/scope.js';
import { curMs, findMember, findMilestone } from '../tasks/tasks.repository.js';
import * as repo from './timesheets.repository.js';
import { addDays, monthOf, range, today, weekOf, workdaysSoFar } from './period.js';
import { events as attendanceEvents } from '../workday/state.repository.js';
import { sumDay } from '../workday/attendance.domain.js';
import { DAY, HOUR, fmtDur, parseDay } from '../workday/time.js';


/**
 * Time actually worked that day (check-in time minus breaks) and the internal-work hours already in
 * that day's shift report — or null when the person has no attendance that day (no check-in to compare with).
 */
async function workedOn(memberId, day, session = null) {
  const start = parseDay(day);
  const evts = await attendanceEvents([memberId], start, start + DAY, session);
  if (!evts.some((e) => e.k === 'login')) return null;
  const s = sumDay(evts, start, Date.now());
  const rep = await ShiftReport.findOne({ person_id: memberId, day }).select('internal_rows').session(session).rows();
  const internal = ((rep && rep.internal_rows) || []).reduce((x, r) => x + (Number(r.h) || 0), 0);
  return { workH: s.work / HOUR, internal };
}

const referenceError = () => new AppError(409, 'REFERENCE_ERROR', 'A referenced record does not exist or is still in use');

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const r2 = (n) => Math.round(Number(n) * 100) / 100;

export const toLog = (r) => ({
  id: r.id,
  memberId: r.member_id,
  memberName: r.member_name ?? null,
  team: r.member_team ?? null,
  projectId: r.project_id,
  projectName: r.project_name ?? null,
  milestoneId: r.milestone_id,
  milestoneName: r.milestone_name ?? null,
  date: r.day,
  hours: Number(r.hours),
  note: r.note,
  source: r.source,
  createdAt: iso(r.created_at),
});

/** Row scope for logs (frontend scopeState): visible projects AND member within the ts scope. */
export async function logScope(user) {
  const [projectIds, ps] = await Promise.all([visibleProjectIds(user), peopleScope(user, 'ts')]);
  return { projectIds, people: ps.people, scope: ps.scope };
}

const periodOf = (f) => range(f.date, f.from, f.to);
const days = (rg) => {
  const T = today();
  return { today: T, yesterday: addDays(T, -1), week: weekOf(T), month: monthOf(T), range: rg };
};

export async function list(user, f) {
  const scope = await logScope(user);
  const page = pageParams(f);
  const sort = sortParam(f.sort, repo.LOG_SORTS, null);
  const { rows, total, hours } = await repo.list(scope, f, periodOf(f), sort, page);
  return { data: rows.map(toLog), meta: { ...page.meta(total), totalHours: hours } };
}

export async function summary(user, f) {
  const scope = await logScope(user);
  const rg = periodOf(f);
  const s = await repo.summary(scope, f, days(rg));
  return { ...s, from: rg ? rg[0] : null, to: rg && rg[1] ? addDays(rg[1], -1) : null };
}

/** Member × project matrix for the range (TimesheetsTab "Member × project"). */
export async function matrix(user, f) {
  const scope = await logScope(user);
  const cells = await repo.matrix(scope, f, periodOf(f));
  const cols = new Map();
  const rows = new Map();
  let max = 0;
  for (const c of cells) {
    const h = Number(c.hours);
    if (!(h > 0)) continue;
    if (!cols.has(c.project_id)) cols.set(c.project_id, { projectId: c.project_id, name: c.project_name, hue: c.project_hue, total: 0 });
    if (!rows.has(c.member_id)) rows.set(c.member_id, { memberId: c.member_id, name: c.member_name, team: c.member_team, hue: c.member_hue, total: 0, cells: {} });
    const row = rows.get(c.member_id);
    row.cells[c.project_id] = h;
    row.total += h;
    cols.get(c.project_id).total += h;
    max = Math.max(max, h);
  }
  const columns = [...cols.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, total: r2(c.total) }));
  const out = [...rows.values()].map((r) => ({
    memberId: r.memberId, name: r.name, team: r.team, hue: r.hue, total: r2(r.total),
    cells: columns.map((c) => ({ projectId: c.projectId, hours: r.cells[c.projectId] || 0 })),
  }));
  return {
    columns,
    rows: out,
    totals: columns.map((c) => ({ projectId: c.projectId, hours: c.total })),
    grand: r2(columns.reduce((x, c) => x + c.total, 0)),
    max,
  };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_HEAD = ['Date', 'Member', 'Team', 'Project', 'Milestone', 'Hours', 'Work done'];

/** CSV of the filtered entries (same columns as the frontend export). */
export async function exportCsv(user, f) {
  const scope = await logScope(user);
  const rows = await repo.all(scope, f, periodOf(f));
  const lines = [CSV_HEAD, ...rows.map((l) => [l.day, l.member_name, l.member_team, l.project_name, l.milestone_name, Number(l.hours), l.note])];
  return { csv: `${lines.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`, count: rows.length, filename: `mariox-timesheets-${today()}.csv` };
}

/**
 * saveLog: { memberId, date, rows:[{projectId, milestoneId?, hours, note}] }.
 * Own-scope users log only for themselves, team scope only for their team. Hours round to 0.25;
 * a member's day can't exceed 24h. Milestone defaults to the project's current milestone.
 */
export async function create(user, body) {
  const scope = await logScope(user);
  const memberId = body.memberId || user.memberId;
  if (!memberId) throw unprocessable('Pick a team member.');
  if (scope.people && !scope.people.includes(memberId)) {
    throw forbidden(scope.scope === 'own' ? 'You can only log your own hours' : 'You can only log hours for your team');
  }
  if (!body.date) throw unprocessable('Pick a date.');
  const rows = body.rows.filter((r) => r.projectId && r.hours > 0);
  if (!rows.length) throw unprocessable('Enter hours for at least one project.');
  const tot = rows.reduce((x, r) => x + r.hours, 0);
  for (const r of rows) {
    if (scope.projectIds && !scope.projectIds.includes(r.projectId)) throw forbidden("You don't have access to this project");
  }

  return tx(async (session) => {
    if (!(await findMember(memberId, session))) throw unprocessable('Pick a team member.');
    const ex = await repo.dayTotal(memberId, body.date, session);
    if (tot + ex > 24) throw unprocessable('That adds up to more than 24 hours for one day.');
    // Logged hours may not exceed the time worked that day (check-in time minus breaks).
    const w = await workedOn(memberId, body.date, session);
    if (w && tot + ex + w.internal > w.workH + 0.01) {
      const left = Math.max(0, r2(w.workH - ex - w.internal));
      throw unprocessable(`Only ${fmtDur(w.workH * HOUR)} was worked that day (check-in time minus breaks) and ${r2(ex + w.internal)}h is already logged — you can add at most ${left}h more.`);
    }
    // Every check (milestones included) runs before the first write: a standalone server can't roll back.
    // No foreign keys in MongoDB: an unknown project gets the answer the FK violation used to give.
    const projectIds = [...new Set(rows.map((r) => r.projectId))];
    if ((await Project.countDocuments({ id: { $in: projectIds } }).session(session)) !== projectIds.length) throw referenceError();
    const entries = [];
    for (const r of rows) {
      const hours = Math.round(r.hours * 4) / 4;
      if (!(hours > 0)) continue;
      let ms = r.milestoneId;
      if (ms) {
        const m = await findMilestone(ms, session);
        if (!m || m.project_id !== r.projectId) throw unprocessable('Pick a milestone of this project.');
      } else {
        ms = await curMs(r.projectId, session);
      }
      entries.push({ member_id: memberId, project_id: r.projectId, milestone_id: ms, day: body.date, hours, note: (r.note || '').trim(), source: 'manual' });
    }
    if (!entries.length) throw unprocessable('Enter hours for at least one project.');
    for (const e of entries) e.id = await nextId('log');
    await repo.insert(entries, session);
    // Two saves for the same member + day may race past the check above: re-check after writing and
    // take this save back if the day now exceeds 24h (replaces the old per member/day advisory lock).
    if ((await repo.dayTotal(memberId, body.date, session)) > 24) {
      await repo.removeMany(entries.map((e) => e.id), session);
      throw unprocessable('That adds up to more than 24 hours for one day.');
    }
    const saved = await repo.findByIds(entries.map((e) => e.id), session);
    return saved.map(toLog);
  });
}

export async function remove(user, id) {
  const scope = await logScope(user);
  const row = await repo.getById(scope, id);
  if (!row) throw notFound('Time entry');
  await repo.remove(id);
}

/**
 * Team & hours (TeamTab): one row per member with today / yesterday / week / month / period hours,
 * shift, allocation vs hours taken on active projects, utilisation and "not submitted" today.
 * When a project / status / search filter is set, hours and allocation only count those projects.
 */
export async function teamHours(user, f) {
  const [visible, ps] = await Promise.all([visibleProjectIds(user), peopleScope(user, 'team')]);
  const projScoped = !!(f.q || f.project || f.status);

  let projectIds = visible;
  if (projScoped) {
    const and = [];
    if (visible) and.push({ _id: { $in: visible } });
    if (f.project) and.push({ _id: f.project });
    if (f.status) and.push({ status: f.status });
    if (f.q) {
      const like = ilike(f.q);
      const named = await Member.distinct('_id', { name: like });
      const staffedByNamed = named.length ? await ProjectMember.distinct('project_id', { member_id: { $in: named } }) : [];
      and.push({ $or: [{ name: like }, { client: like }, { _id: like }, { _id: { $in: staffedByNamed } }] });
    }
    projectIds = await Project.distinct('_id', and.length ? { $and: and } : {});
  }

  const memberAnd = [{ active: true }];
  if (ps.people) memberAnd.push({ _id: { $in: ps.people } });
  if (f.member) memberAnd.push({ _id: f.member });
  if (f.team) memberAnd.push({ team: f.team });
  if (projScoped) {
    const onProjects = await ProjectMember.distinct('member_id', { project_id: { $in: projectIds } });
    const either = [{ _id: { $in: onProjects } }];
    if (f.q) either.push({ name: ilike(f.q) }, { role_title: ilike(f.q) });
    memberAnd.push({ $or: either });
  }
  const memberFilter = { $and: memberAnd };
  const page = pageParams(f, { defaultSize: 100 });
  const [count, members] = await Promise.all([
    Member.countDocuments(memberFilter),
    Member.find(memberFilter).sort({ name: 1, _id: 1 }).collation(TEXT_ORDER).skip(page.offset).limit(page.limit).rows(),
  ]);
  const ids = members.map((m) => m.id);

  const rg = periodOf(f);
  const [hrs, alloc] = await Promise.all([repo.memberHours(ids, projectIds, days(rg)), repo.allocation(ids, projectIds)]);
  const H = Object.fromEntries(hrs.map((h) => [h.member_id, h]));
  const A = Object.fromEntries(alloc.map((a) => [a.member_id, a]));
  const wk = weekOf();
  const wd = workdaysSoFar(wk[0], wk[1]);

  const rows = members.map((m) => {
    const h = H[m.id] || {};
    const a = A[m.id] || {};
    const hours = Object.fromEntries(['today', 'yesterday', 'week', 'month', 'range', 'all'].map((k) => [k, r2(h[k] || 0)]));
    const sh = Number(m.shift_hours) || 8;
    const allocated = r2(a.allocated || 0);
    const taken = r2(a.taken || 0);
    const u = allocated ? taken / allocated : 0;
    return {
      memberId: m.id, name: m.name, roleTitle: m.role_title, team: m.team, hue: m.hue, shiftHours: sh,
      hours,
      weekExpected: r2(sh * wd),
      allocated, taken, utilisation: Math.round(u * 1000) / 1000, utilisationPct: allocated ? Math.round(u * 100) : null,
      projects: Number(a.projects || 0),
      notSubmitted: !!a.running && hours.today === 0 && !projScoped,
      todayState: hours.today > sh ? 'overtime' : hours.today >= sh ? 'full' : 'short',
    };
  });
  return { data: rows, meta: { ...page.meta(Number(count)), from: rg ? rg[0] : null, to: rg && rg[1] ? addDays(rg[1], -1) : null } };
}
