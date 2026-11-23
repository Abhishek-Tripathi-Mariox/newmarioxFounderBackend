/**
 * GET /founder/summary — the Mariox summary the cofounder portal reads (CofounderMariox README →
 * "Summary API"). Read-only, everyone's data (no user scope): it is guarded by FOUNDER_API_KEY.
 *
 * Periods are in the business time zone (APP_TZ): today, this week (from Monday) and this month,
 * each "to date". `prev` is the same span of the previous week / month, so a Wednesday is compared
 * with last Monday–Wednesday rather than with a whole week.
 * Money in rupees; dates ISO 8601 (calendar days as the start of that day in APP_TZ).
 * Not tracked by the internal portal: client payments, so `cash` is null.
 * Also: end-of-shift reports + blockers, quotes waiting on clients, projects on hold, team tasks,
 * and the detail lists of `details()` (attendance and hours this week, follow-ups, new leads,
 * milestones, bugs by severity, change requests and quotes waiting on the client).
 */
import * as repo from './founder.repository.js';
import * as workday from '../workday/workday.repository.js';
import { events } from '../workday/state.repository.js';
import { liveState } from '../workday/state.service.js';
import { groupAttendance, sumDay, isLate } from '../workday/attendance.domain.js';
import { DAY, MINUTE, sod, addDays, weekday, isSunday, monthStart, parseDay, ymd, iso } from '../workday/time.js';

const WEEKS = 12;
/** Longest list sent in a detail block; the block's `count` tells how many there are in all. */
const LIST_MAX = 10;
/** Projects listed in "hours logged this week". */
const TOP_PROJECTS = 8;
const SEVERITIES = ['Critical', 'Major', 'Minor', 'Trivial'];
/** Past days of attendance sent with the summary (enough for yesterday and the whole current week). */
const HISTORY_DAYS = 7;

const num = (v) => Number(v) || 0;
const ms = (v) => (v == null ? null : new Date(v).getTime());
/** 'YYYY-MM-DD' (or a Date) → ISO instant of that day's start in APP_TZ. */
const dayIso = (d) => (d ? iso(parseDay(typeof d === 'string' ? d.slice(0, 10) : ymd(new Date(d).getTime()))) : null);

/** Period bounds (epoch ms) for `now`. */
export function periods(now) {
  const T = sod(now);
  const weekStart = addDays(T, -((weekday(T) + 6) % 7));
  const monthStartT = monthStart(T);
  const prevMonth = monthStart(T, -1);
  return {
    T,
    weekStart,
    monthStart: monthStartT,
    today: { from: T, to: now },
    week: { from: weekStart, to: now, prevFrom: addDays(weekStart, -7), prevTo: addDays(weekStart, -7) + (now - weekStart) },
    month: { from: monthStartT, to: now, prevFrom: prevMonth, prevTo: Math.min(prevMonth + (now - monthStartT), monthStartT) },
  };
}

/** Won / lost leads with the time they closed: the last "Stage: … → Won|Lost" activity, else updated_at. */
async function closedLeads() {
  const rows = await repo.closedLeads();
  return rows.map((r) => ({ id: r.id, status: r.status, value: num(r.value), owner: r.owner_id, at: ms(r.closed_at) }));
}

const within = (rows, from, to) => rows.filter((r) => r.at >= from && r.at < to);
const total = (rows) => ({ value: rows.reduce((a, r) => a + r.value, 0), deals: rows.length });

function wonBlock(won, p) {
  const cur = total(within(won, p.from, p.to));
  if (p.prevFrom == null) return cur;
  return { ...cur, prev: total(within(won, p.prevFrom, p.prevTo)).value };
}

/** Current milestone (first not Done), budget use and the pending client approval for one project. */
function projectRow(p, milestones, logged) {
  const cur = milestones.find((m) => m.status !== 'Done');
  const budget = p.budget_hours != null ? num(p.budget_hours) : milestones.reduce((a, m) => a + num(m.alloc_hours), 0);
  const projectDue = p.expected_delivery_date || p.due_date;
  const last = milestones.at(-1);
  return {
    id: p.id,
    name: p.name,
    client: p.client,
    pm: p.pm_name || '—',
    milestone: cur
      ? { n: cur.n, name: cur.name, due: dayIso(cur.due_date || projectDue) }
      : { n: last ? last.n : null, name: last ? 'All milestones done' : 'No milestones yet', due: dayIso(projectDue) },
    hoursUsed: budget > 0 ? Math.round((logged / budget) * 100) / 100 : null,
    hoursLogged: Math.round(logged * 100) / 100,
    hoursBudget: budget > 0 ? budget : null,
    approvalAskedAt: cur && cur.approval_status === 'Pending' && cur.approval_asked_at ? iso(ms(cur.approval_asked_at)) : null,
    note: p.status_note || '',
  };
}

function personRow(p, live, T) {
  const a = live.att[p.id];
  const t = live.timers[p.id];
  return {
    id: p.id,
    name: p.name,
    hue: p.hue,
    team: p.team,
    checkInAt: a && a.in ? a.in : null,
    checkOutAt: a && a.out ? a.out : null,
    late: isLate(a && a.in ? ms(a.in) : null, T),
    break: a && a.brk ? { kind: a.brkType || 'Break', startedAt: a.brk, plannedMin: a.brkPlan || null } : null,
    timer: t ? { task: t.title, projectId: t.p, startedAt: t.start } : null,
    activity: null,
  };
}

/**
 * Extra founder numbers (added after the first version of the summary):
 *  reports    today's end-of-shift reports and the blockers people wrote (today + yesterday)
 *  quotes     proposals waiting on the client (Sent / Viewed) and accepted this month
 *  onHold     projects on hold, with the reason the PM gave
 *  teamTasks  tasks assigned to the team (Team tasks): open, overdue, done this week
 */
async function extras(P, now, people, live) {
  const T = P.T;
  const yesterday = ymd(addDays(T, -1));
  const [reports, quotes, held, tasks] = await Promise.all([
    repo.shiftReportsSince(yesterday),
    repo.liveQuotes(),
    repo.projectsOnHold(),
    repo.teamTasks(),
  ]);

  const nameOf = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const today = ymd(T);
  const dayOf = (d) => (typeof d === 'string' ? d.slice(0, 10) : ymd(new Date(d).getTime()));
  const todays = reports.filter((r) => dayOf(r.day) === today);
  const blockers = reports
    .filter((r) => (r.blockers || '').trim())
    .sort((a, b) => ms(b.submitted_at) - ms(a.submitted_at))
    .map((r) => ({ who: r.person_id, name: nameOf[r.person_id] || r.person_id, text: r.blockers.trim(), day: dayIso(dayOf(r.day)), at: iso(ms(r.submitted_at)) }));

  const amount = (q) => num(q.net) || num(q.total);
  const waiting = quotes.filter((q) => q.status === 'Sent' || q.status === 'Viewed');
  const accepted = quotes.filter((q) => q.status === 'Accepted' && ms(q.accepted_at) >= P.month.from);
  const oldest = waiting.reduce((m, q) => (q.sent_at && (m == null || ms(q.sent_at) < m) ? ms(q.sent_at) : m), null);

  const open = tasks.filter((t) => t.status !== 'Done');
  const overdue = open.filter((t) => t.due_date && dayOf(t.due_date) < today).sort((a, b) => (dayOf(a.due_date) < dayOf(b.due_date) ? -1 : 1));

  return {
    reports: { checkedIn: Object.keys(live.att).length, submitted: todays.length, blockers: blockers.slice(0, 10) },
    quotes: {
      waiting: {
        count: waiting.length,
        value: waiting.reduce((a, q) => a + amount(q), 0),
        oldestSentAt: iso(oldest),
        list: waiting
          .sort((a, b) => (ms(a.sent_at) ?? Infinity) - (ms(b.sent_at) ?? Infinity) || (a.id < b.id ? -1 : 1))
          .slice(0, LIST_MAX)
          .map((q) => ({
            id: q.id, leadId: q.leadId, company: q.company, status: q.status, amount: amount(q), total: num(q.total),
            sentAt: iso(ms(q.sent_at)), viewedAt: iso(ms(q.viewed_at)),
          })),
      },
      acceptedMonth: { count: accepted.length, value: accepted.reduce((a, q) => a + amount(q), 0) },
    },
    onHold: held.map((p) => ({
      id: p.id, name: p.name, client: p.client, pm: p.pm_name || '—', reason: p.status_reason || '', note: p.status_note || '',
      since: iso(ms(p.status_note_at || p.updated_at)),
    })),
    teamTasks: {
      open: open.length,
      overdue: overdue.length,
      doneWeek: tasks.filter((t) => t.done_at && ms(t.done_at) >= P.weekStart).length,
      overdueList: overdue.slice(0, 5).map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, priority: t.priority, due: dayIso(dayOf(t.due_date)) })),
    },
  };
}

/**
 * Attendance for the past HISTORY_DAYS working days (Sundays skipped), newest first. Each day lists
 * only the people who checked in. A day without a logout keeps checkOutAt null and counts work up
 * to the last break / logout event only.
 */
async function attendanceHistory(T, now) {
  const from = addDays(T, -HISTORY_DAYS);
  const byPersonDay = groupAttendance(await events(null, from, T), from, T);
  const days = [];
  for (let i = 1; i <= HISTORY_DAYS; i++) {
    const day = addDays(T, -i);
    if (isSunday(day)) continue;
    const people = [];
    for (const [key, list] of Object.entries(byPersonDay)) {
      const [who, dayKey] = key.split('|');
      if (Number(dayKey) !== day) continue;
      const s = sumDay(list, day, now);
      if (s.first == null) continue;
      people.push({
        id: who,
        checkInAt: iso(s.first),
        checkOutAt: iso(s.last),
        late: isLate(s.first, day),
        workedMin: Math.round(s.work / MINUTE),
        breakMin: Math.round(s.br / MINUTE),
        breaks: s.breaks.length,
      });
    }
    days.push({ day: iso(day), people });
  }
  return days;
}

/** Monday … today of this week, Sundays skipped (the days people are expected in). */
function workdaysThisWeek(P) {
  const days = [];
  for (let d = P.weekStart; d <= P.T; d = addDays(d, 1)) if (!isSunday(d)) days.push(d);
  return days;
}

/**
 * Attendance this week (Monday to now) per person: days present, days late, minutes worked (today's
 * open segment runs until `now`) and the minutes expected from their shift over the working days so far.
 */
async function attendanceWeek(P, now, people) {
  const end = addDays(P.T, 1);
  const byPersonDay = groupAttendance(await events(null, P.weekStart, end), P.weekStart, end);
  const workdays = workdaysThisWeek(P).length;
  const stats = Object.fromEntries(people.map((p) => [p.id, { daysPresent: 0, lateDays: 0, workedMs: 0 }]));
  for (const [key, list] of Object.entries(byPersonDay)) {
    const [who, dayKey] = key.split('|');
    const s = stats[who];
    if (!s) continue;
    const day = Number(dayKey);
    const sum = sumDay(list, day, now);
    if (sum.first == null) continue;
    s.daysPresent++;
    if (isLate(sum.first, day)) s.lateDays++;
    s.workedMs += sum.work;
  }
  return {
    from: iso(P.weekStart),
    workdays,
    people: people
      .map((p) => {
        const s = stats[p.id];
        return {
          id: p.id, name: p.name, hue: p.hue, team: p.team,
          daysPresent: s.daysPresent, lateDays: s.lateDays,
          workedMin: Math.round(s.workedMs / MINUTE), expectedMin: Math.round(p.shift * 60 * workdays),
        };
      })
      .sort((a, b) => b.daysPresent - a.daysPresent || b.workedMin - a.workedMin || a.name.localeCompare(b.name)),
  };
}

/** Hours logged this week (time logs from Monday) by project and by delivery member, against their shift hours. */
async function hoursWeek(P, people) {
  const workdays = workdaysThisWeek(P).length;
  const logged = await repo.hoursSince(ymd(P.weekStart));
  const byMember = Object.fromEntries(logged.members.map((r) => [r.id, r.h]));
  const members = people.filter((p) => !p.sales);
  const round1 = (n) => Math.round(n * 10) / 10;
  const projects = [...logged.projects].sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  return {
    from: iso(P.weekStart),
    workdays,
    total: round1(logged.members.reduce((a, r) => a + r.h, 0)),
    expected: round1(members.reduce((a, p) => a + p.shift * workdays, 0)),
    projects: { count: projects.length, list: projects.slice(0, TOP_PROJECTS).map((r) => ({ id: r.id, name: r.name, hours: round1(r.h) })) },
    people: members
      .map((p) => ({ id: p.id, name: p.name, hue: p.hue, team: p.team, hours: round1(byMember[p.id] || 0), expected: round1(p.shift * workdays) }))
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)),
  };
}

/** Running-project milestones not Done: overdue (due before today) and due in the next 7 days. */
function milestoneLists(P, projects, msBy) {
  const today = ymd(P.T);
  const weekAhead = ymd(addDays(P.T, 7));
  const dayOf = (d) => (typeof d === 'string' ? d.slice(0, 10) : ymd(new Date(d).getTime()));
  const rows = [];
  for (const p of projects) {
    for (const m of msBy[p.id] || []) {
      if (m.status === 'Done' || !m.due_date) continue;
      rows.push({
        id: m.id, projectId: p.id, projectName: p.name, client: p.client, n: m.n, name: m.name,
        dueDay: dayOf(m.due_date), status: m.status,
        approvalPending: m.approval_status === 'Pending', approvalAskedAt: m.approval_status === 'Pending' ? iso(ms(m.approval_asked_at)) : null,
      });
    }
  }
  rows.sort((a, b) => (a.dueDay < b.dueDay ? -1 : a.dueDay > b.dueDay ? 1 : a.n - b.n));
  const block = (list) => ({
    count: list.length,
    list: list.slice(0, LIST_MAX).map(({ dueDay, ...r }) => ({ ...r, due: dayIso(dueDay) })),
  });
  return {
    overdue: block(rows.filter((r) => r.dueDay < today)),
    dueSoon: block(rows.filter((r) => r.dueDay >= today && r.dueDay <= weekAhead)),
  };
}

/**
 * Detail lists for the founder's Internal portal tab (added with the "more detail" pass):
 *  attendanceWeek  per person days present / late / worked vs expected, this week
 *  hoursWeek       time logs this week by project (top 8) and by member, vs shift hours
 *  followUps       open follow-ups overdue or due today
 *  newLeads        leads created in the last 7 days; sourcesMonth: leads this month per source
 *  milestones      overdue and due in the next 7 days (running projects)
 *  bySeverity      open bugs per severity; crList: change requests waiting on the client
 */
async function details(P, now, people, projects, msBy) {
  const [attendance, hours, fus, recent, sources, severities, crs] = await Promise.all([
    attendanceWeek(P, now, people),
    hoursWeek(P, people),
    repo.followUpsDueBefore(addDays(P.T, 1)),
    repo.leadsSince(now - 7 * DAY),
    repo.leadSourcesSince(P.monthStart),
    repo.openBugsBySeverity(),
    repo.crsWaitingList(),
  ]);
  const owners = await repo.ownersById([...fus.map((f) => f.owner_id), ...recent.map((l) => l.owner_id)]);
  const ownerOf = (id) => owners.get(id) || { name: id, hue: 265 };

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const r of severities) bySeverity[r.severity] = (bySeverity[r.severity] || 0) + r.n;

  return {
    attendance,
    hours,
    followUps: {
      count: fus.length,
      overdue: fus.filter((f) => ms(f.due_at) < now).length,
      list: fus.slice(0, LIST_MAX).map((f) => ({
        id: f.id, type: f.type, title: f.title, priority: f.priority, leadId: f.lead_id || null, company: f.company,
        ownerId: f.owner_id, owner: ownerOf(f.owner_id).name, hue: ownerOf(f.owner_id).hue,
        dueAt: iso(ms(f.due_at)), overdue: ms(f.due_at) < now,
      })),
    },
    newLeads: {
      count: recent.length,
      value: recent.reduce((a, l) => a + num(l.value), 0),
      list: recent.slice(0, LIST_MAX).map((l) => ({
        id: l.id, company: l.company, source: l.source || 'Not set', ownerId: l.owner_id, owner: ownerOf(l.owner_id).name, hue: ownerOf(l.owner_id).hue,
        value: num(l.value), stage: l.status, createdAt: iso(ms(l.created_at)),
      })),
    },
    sourcesMonth: sources
      .map((r) => ({ source: r.source || 'Not set', count: r.count }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    milestones: milestoneLists(P, projects, msBy),
    bySeverity,
    crList: crs.slice(0, LIST_MAX).map((c) => ({
      id: c.id, projectId: c.project_id, projectName: c.project_name, title: c.title, amount: num(c.amount), sentAt: iso(ms(c.sent_at || c.raised_at)),
    })),
  };
}

const STATE_ORDER = { in: 0, break: 1, left: 2, out: 3 };
const stateOf = (x) => (!x.checkInAt ? 'out' : x.break ? 'break' : x.checkOutAt ? 'left' : 'in');

export async function marioxSummary(now = Date.now()) {
  const P = periods(now);

  const [closed, openLeads, newToday, newWeek, stageNames, owners, openFus, crs, bugsOpen, critical, projects, people, live, logsToday, history] = await Promise.all([
    closedLeads(),
    repo.openLeads(),
    repo.leadsCreatedSince(P.T),
    repo.leadsCreatedSince(P.weekStart),
    repo.openStageNames(),
    repo.activeSalesOwners(),
    repo.openFollowUps(),
    repo.crsWaiting(),
    repo.openBugCount(),
    repo.openCriticalBugs(),
    repo.runningProjects(),
    workday.people(),
    liveState(null, now),
    repo.hoursLoggedOn(ymd(P.T)),
    attendanceHistory(P.T, now),
  ]);

  const ids = projects.map((p) => p.id);
  const [milestones, logged] = await Promise.all([repo.milestonesOf(ids), repo.hoursByProject(ids)]);
  const msBy = {};
  for (const m of milestones) (msBy[m.project_id] = msBy[m.project_id] || []).push(m);
  const loggedBy = Object.fromEntries(logged.map((r) => [r.project_id, num(r.h)]));

  // Sales
  const won = closed.filter((l) => l.status === 'Won');
  const lost = closed.filter((l) => l.status === 'Lost');
  const open = openLeads.map((l) => ({ status: l.status, owner: l.owner_id, value: num(l.value) }));
  const quarter = closed.filter((l) => l.at >= now - 90 * DAY && l.at < now);
  const qWon = quarter.filter((l) => l.status === 'Won').length;

  const stages = stageNames.map((name) => {
    const inStage = open.filter((l) => l.status === name);
    return { key: name, name, count: inStage.length, value: inStage.reduce((a, l) => a + l.value, 0) };
  });
  // Leads in a stage that was since removed from the master list still count as open pipeline.
  const orphan = open.filter((l) => !stageNames.includes(l.status));
  if (orphan.length) stages.push({ key: 'other', name: 'Other', count: orphan.length, value: orphan.reduce((a, l) => a + l.value, 0) });

  const wonMonth = within(won, P.month.from, P.month.to);
  const ownerRows = owners.map((o) => {
    const mine = open.filter((l) => l.owner === o.id);
    return {
      id: o.id,
      name: o.name,
      hue: o.hue,
      open: mine.length,
      value: mine.reduce((a, l) => a + l.value, 0),
      wonMonth: wonMonth.filter((l) => l.owner === o.id).reduce((a, l) => a + l.value, 0),
      overdue: openFus.filter((f) => f.owner_id === o.id && ms(f.due_at) < now).length,
    };
  });

  // Team
  const team = people.map((p) => personRow(p, live, P.T))
    .sort((a, b) => STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)] || a.name.localeCompare(b.name));
  const count = (s) => team.filter((x) => stateOf(x) === s).length;

  // Weekly revenue won (Monday-based weeks, oldest first, the current week last)
  const firstWeek = addDays(P.weekStart, -7 * (WEEKS - 1));
  const weekly = Array.from({ length: WEEKS }, (_, i) => {
    const from = addDays(firstWeek, 7 * i);
    return { weekOf: iso(from), value: total(within(won, from, addDays(from, 7))).value };
  });

  const [more, detail] = await Promise.all([extras(P, now, people, live), details(P, now, people, projects, msBy)]);

  return {
    company: 'mariox',
    syncedAt: iso(now),
    sales: {
      won: { today: wonBlock(won, P.today), week: wonBlock(won, P.week), month: wonBlock(won, P.month) },
      lost: { month: total(within(lost, P.month.from, P.month.to)), topReason: null },
      newDeals: { today: newToday, week: newWeek },
      winRateQuarter: quarter.length ? Math.round((qWon / quarter.length) * 100) / 100 : 0,
      stages,
      owners: ownerRows,
      followUps: { dueToday: openFus.filter((f) => ms(f.due_at) >= P.T && ms(f.due_at) < addDays(P.T, 1)).length, due: detail.followUps },
      newLeads: detail.newLeads,
      sourcesMonth: detail.sourcesMonth,
    },
    cash: null,
    changeRequests: { waitingOnClient: crs.n, value: crs.v, list: detail.crList },
    bugs: {
      open: bugsOpen,
      bySeverity: detail.bySeverity,
      critical: critical.map((b) => ({ id: b.id, projectId: b.project_id, projectName: b.project_name, title: b.title, openedAt: dayIso(b.reported_on) })),
    },
    projects: {
      running: projects.length,
      list: projects.map((p) => projectRow(p, msBy[p.id] || [], loggedBy[p.id] || 0))
        .sort((a, b) => (ms(a.milestone.due) ?? Infinity) - (ms(b.milestone.due) ?? Infinity)),
      onHold: more.onHold,
      milestones: detail.milestones,
    },
    reports: more.reports,
    quotes: more.quotes,
    teamTasks: more.teamTasks,
    team: {
      size: team.length,
      in: count('in'),
      onBreak: count('break'),
      left: count('left'),
      notIn: count('out'),
      late: team.filter((x) => x.late).length,
      hoursToday: Math.round(logsToday * 10) / 10,
      people: team,
      days: history,
      week: detail.attendance,
    },
    hoursWeek: detail.hours,
    weekly,
  };
}
