import { PpAcqLead, PpBooking, PpLead, PpProject, PpScope, PpTechRequest, PpTicket, PpUser } from '../../../db/models/index.js';
import { DEFAULT_COMMISSION_RATE, PROJECT_STAGES } from '../lib/constants.js';
import { commissionState } from '../lib/metrics.js';
import { LOST, WON, getPipeline } from '../lib/pipeline.js';

/*
 * Partner-network summary for the cofounder portal / Founders HQ (mariox-saas src/lib/founder.ts).
 * Read-only and across all partners. Call `partnersSummary()` in-process, or over HTTP at
 * GET /api/v1/pp/founder/summary with `x-founder-key: <FOUNDER_API_KEY>`.
 *
 * Days, weeks (from Monday) and months are in IST, "to date"; `prev` is the same span of the
 * previous week / month. Money in rupees, timestamps ISO 8601.
 *
 * Commission per client payment = amount × the project's locked rate (else the partner's rate):
 *   toPay     client paid, payout not released yet  → what Mariox owes partners now
 *   clientDue client payment is due                  → commission follows once the client pays
 *   released  paid out (releasedAt / UTR)
 *   upcoming  later client payments
 */

const IST = 5.5 * 36e5;
const DAY = 864e5;
const WEEKS = 12;
/** Longest list sent in a detail block; the block's `count` tells how many there are in all. */
const LIST_MAX = 10;
/** Latest open items sent per request kind. */
const LATEST_PER_KIND = 3;
const REQUEST_KIND_ORDER = ['scope', 'visit', 'tech', 'ticket'];
/** Acquisition statuses still being worked (acquisition.rules OPEN). */
const ACQ_OPEN = ['contacted', 'meeting', 'followup'];
const ACQ_STATUS_LABEL = { contacted: 'Lead', meeting: 'Meeting', followup: 'Follow-up', converted: 'Converted', onboarding: 'Onboarding', rejected: 'Rejected' };

/** Midnight IST of the day containing `t`, as epoch ms. */
const istDay = (t) => Math.floor((t + IST) / DAY) * DAY - IST;
const istYmd = (t) => new Date(t + IST).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' (+ optional 'HH:MM') read as IST → epoch ms. */
const fromIst = (day, time) => {
  if (!day || !/^\d{4}-\d\d-\d\d/.test(day)) return null;
  const t = Date.parse(`${day.slice(0, 10)}T${/^\d\d:\d\d$/.test(time || '') ? time : '00:00'}:00+05:30`);
  return Number.isNaN(t) ? null : t;
};
const isoOf = (t) => (t == null ? null : new Date(t).toISOString());
const ms = (v) => (v == null ? null : new Date(v).getTime());

/** Today / this week (from Monday) / this month in IST, with the matching previous spans. */
export function periods(now) {
  const T = istDay(now);
  const dow = new Date(T + IST).getUTCDay(); // 0 = Sunday
  const weekStart = T - ((dow + 6) % 7) * DAY;
  const d = new Date(T + IST);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST;
  const prevMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) - IST;
  return {
    T,
    weekStart,
    monthStart,
    today: { from: T, to: now },
    week: { from: weekStart, to: now, prevFrom: weekStart - 7 * DAY, prevTo: weekStart - 7 * DAY + (now - weekStart) },
    month: { from: monthStart, to: now, prevFrom: prevMonth, prevTo: Math.min(prevMonth + (now - monthStart), monthStart) },
  };
}

/** When a won lead was won: its 'won' activity, else its last update. */
function wonAt(l) {
  const a = (l.activities || []).find((x) => x.type === 'won');
  return (a && (ms(a.createdAt) ?? fromIst(a.date))) ?? ms(l.updatedAt) ?? 0;
}

const within = (rows, from, to) => rows.filter((r) => r.at >= from && r.at < to);
const total = (rows) => ({ value: rows.reduce((a, r) => a + r.value, 0), deals: rows.length });
const wonBlock = (won, p) => {
  const cur = total(within(won, p.from, p.to));
  return p.prevFrom == null ? cur : { ...cur, prev: total(within(won, p.prevFrom, p.prevTo)).value };
};

const STATUS_LABEL = { review: 'In review', requested: 'Requested', assigned: 'Assigned', Requested: 'Requested', Rescheduled: 'Rescheduled' };

/**
 * The whole partner-network summary (same shape as the source's `{ data }`).
 * @param {number} [now=Date.now()]
 */
export async function partnersSummary(now = Date.now()) {
  const P = periods(now);
  const ownerBrief = { path: 'owner', select: 'name company' };

  const [partners, leads, projects, scopes, bookings, techs, tickets, acq, pipe] = await Promise.all([
    PpUser.find({ role: 'partner' }).select('name company partnerCode status pan bankAccount ifsc createdAt').lean(),
    PpLead.find({}).select('owner company value stage createdAt updatedAt activities.type activities.date activities.createdAt').lean(),
    PpProject.find({}).select('client title stage update milestones commissionRate owner payments updatedAt').populate({ path: 'owner', select: 'name company partnerCode commissionRate' }).lean(),
    PpScope.find({ status: 'review' }).populate(ownerBrief).lean(),
    PpBooking.find({ status: { $in: ['Requested', 'Rescheduled'] } }).populate(ownerBrief).lean(),
    PpTechRequest.find({ status: { $in: ['requested', 'assigned'] } }).populate(ownerBrief).lean(),
    PpTicket.find({ status: { $in: ['requested', 'assigned'] } }).populate(ownerBrief).lean(),
    PpAcqLead.find({ sample: { $ne: true } }).select('name company owner status contactedAt reason steps meet next').lean(),
    getPipeline(),
  ]);

  const partnerName = (o) => (o ? o.company || o.name || 'Partner' : 'Partner');

  // Leads
  const isOpen = (s) => s !== WON && s !== LOST;
  const open = leads.filter((l) => isOpen(l.stage));
  const won = leads.filter((l) => l.stage === WON).map((l) => ({ owner: String(l.owner), value: l.value || 0, at: wonAt(l) }));
  const created = (from) => leads.filter((l) => (ms(l.createdAt) ?? 0) >= from).length;

  // Commission ledger
  const rows = [];
  /** Partner id + project title of each ledger row (kept out of the existing row shape). */
  const rowSource = new Map();
  for (const pr of projects) {
    const rate = pr.commissionRate ?? pr.owner?.commissionRate ?? DEFAULT_COMMISSION_RATE;
    for (const p of pr.payments || []) {
      rowSource.set(String(p._id), { ownerId: pr.owner?._id ? String(pr.owner._id) : null, title: pr.title || '' });
      rows.push({
        id: String(p._id),
        partner: pr.owner?.name || 'Partner',
        code: pr.owner?.partnerCode || '',
        company: pr.owner?.company || '',
        client: pr.client,
        label: p.label,
        amount: p.amount || 0,
        commission: Math.round((p.amount || 0) * rate),
        dueOn: isoOf(fromIst(p.due)),
        releasedOn: isoOf(fromIst(p.releasedAt)),
        utr: p.utr || null,
        state: commissionState(p),
      });
    }
  }
  const byDue = (a, b) => (ms(a.dueOn) ?? Infinity) - (ms(b.dueOn) ?? Infinity);
  const pick = (state) => rows.filter((r) => r.state === state);
  const sum = (list) => list.reduce((a, r) => a + r.commission, 0);
  const strip = ({ state, ...r }) => { void state; return r; };
  const toPay = pick('processing').sort(byDue);
  const released = pick('released').sort((a, b) => (ms(b.releasedOn) ?? 0) - (ms(a.releasedOn) ?? 0));

  // Requests waiting on Mariox
  const requests = [
    ...scopes.map((s) => ({
      id: String(s._id), kind: 'scope', title: `${s.client} · ${s.project}`, detail: `${(s.lines || []).length} line items`, amount: s.submitted || 0,
      partner: partnerName(s.owner), createdAt: isoOf(ms(s.createdAt)), status: STATUS_LABEL[s.status] || s.status, escalated: false,
    })),
    ...tickets.map((t) => ({
      id: String(t._id), kind: 'ticket', title: `${t.code ? `${t.code} · ` : ''}${t.subject}`, detail: t.category || '',
      partner: partnerName(t.owner), createdAt: isoOf(ms(t.createdAt)), status: STATUS_LABEL[t.status] || t.status, escalated: !!t.escalate,
    })),
    ...bookings.map((b) => ({
      id: String(b._id), kind: 'visit', title: `${b.purpose || 'Office visit'} with ${b.client}`,
      partner: partnerName(b.owner), createdAt: isoOf(ms(b.createdAt)), status: STATUS_LABEL[b.status] || b.status, escalated: false,
      scheduledAt: isoOf(fromIst(b.date, b.time)), where: [b.office && `${b.office} office`, b.guests && `${b.guests} guests`].filter(Boolean).join(' · '),
    })),
    ...techs.map((t) => ({
      id: String(t._id), kind: 'tech', title: `${t.type} for ${t.client}`,
      partner: partnerName(t.owner), createdAt: isoOf(ms(t.createdAt)), status: STATUS_LABEL[t.status] || t.status, escalated: false,
      scheduledAt: isoOf(fromIst(t.date, t.time)), where: [t.mode, t.duration].filter(Boolean).join(' · '),
    })),
  ].sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));

  // Partner recruitment: everyone first contacted this month (IST)
  const monthDay = istYmd(P.monthStart);
  const cohort = acq.filter((l) => (l.contactedAt || '') >= monthDay);
  const met = (l) => (l.steps || []).some((s) => s.k === 'meeting' || s.k === 'done');
  const signed = (l) => l.status === 'converted' || l.status === 'onboarding';
  const team = new Map();
  for (const l of cohort) {
    const name = l.owner || 'Unassigned';
    const t = team.get(name) || { name, contacted: 0, meetings: 0, signed: 0 };
    t.contacted++;
    if (met(l)) t.meetings++;
    if (signed(l)) t.signed++;
    team.set(name, t);
  }
  const reasons = new Map();
  for (const l of cohort) if (l.status === 'rejected') reasons.set(l.reason || 'Not given', (reasons.get(l.reason || 'Not given') || 0) + 1);

  // Partners who need a nudge
  const active = partners.filter((p) => p.status === 'active');
  const invited = partners.filter((p) => p.status === 'invited');
  const payoutMissing = active.filter((p) => !p.pan || !p.bankAccount || !p.ifsc);
  const owedCodes = new Set(toPay.map((r) => r.code));
  const recentLead = new Set(leads.filter((l) => (ms(l.createdAt) ?? 0) >= now - 30 * DAY).map((l) => String(l.owner)));

  // Top partners this month
  const wonMonth = within(won, P.month.from, P.month.to);
  const lastLead = new Map();
  for (const l of leads) {
    const k = String(l.owner);
    const t = ms(l.createdAt) ?? 0;
    if (t > (lastLead.get(k) ?? 0)) lastLead.set(k, t);
  }
  const topPartners = partners
    .map((p) => {
      const id = String(p._id);
      return {
        name: p.name, company: p.company || '', code: p.partnerCode || '',
        openLeads: open.filter((l) => String(l.owner) === id).length,
        won: wonMonth.filter((w) => w.owner === id).reduce((a, w) => a + w.value, 0),
        lastLeadAt: isoOf(lastLead.get(id) ?? null),
      };
    })
    .filter((p) => p.won > 0 || p.openLeads > 0)
    .sort((a, b) => b.won - a.won || b.openLeads - a.openLeads)
    .slice(0, 5);

  const firstWeek = P.weekStart - (WEEKS - 1) * 7 * DAY;
  const more = details({ now, P, partners, leads, projects, rows, rowSource, requests, acq, cohort, pipe, won });

  return {
    company: 'partners',
    syncedAt: new Date(now).toISOString(),
    rate: DEFAULT_COMMISSION_RATE,
    counts: { total: partners.length, active: active.length, invited: invited.length, disabled: partners.filter((p) => p.status === 'disabled').length },
    pipeline: {
      open: open.length,
      value: open.reduce((a, l) => a + (l.value || 0), 0),
      // Open partner leads per stage of the admin-configured pipeline (unknown stages under "Other").
      stages: [...pipe.stages.map((st) => ({ key: st.key, name: st.name })), { key: '__other', name: 'Other' }]
        .map((st) => {
          const inStage = open.filter((l) => (st.key === '__other' ? !pipe.stages.some((x) => x.key === l.stage) : l.stage === st.key));
          return { key: st.key, name: st.name, count: inStage.length, value: inStage.reduce((a, l) => a + (l.value || 0), 0) };
        })
        .filter((st) => st.key !== '__other' || st.count > 0),
    },
    delivery: {
      projects: projects.length,
      stages: PROJECT_STAGES.map((name, i) => ({ name, count: projects.filter((pr) => (pr.stage ?? 0) === i).length })),
      list: projects
        .filter((pr) => (pr.stage ?? 0) < PROJECT_STAGES.length - 1)
        .map((pr) => ({
          client: pr.client, title: pr.title || '', partner: partnerName(pr.owner), stage: PROJECT_STAGES[pr.stage ?? 0],
          nextDate: isoOf(fromIst((pr.milestones || [])[(pr.stage ?? 0) + 1] || null)), update: pr.update || '',
        }))
        .slice(0, 10),
    },
    newDeals: { today: created(P.T), week: created(P.weekStart) },
    won: { today: wonBlock(won, P.today), week: wonBlock(won, P.week), month: wonBlock(won, P.month) },
    commission: {
      toPay: toPay.map(strip),
      clientDue: pick('due').sort(byDue).map(strip),
      recentReleased: released.slice(0, 10).map(strip),
      released: sum(released),
      upcoming: sum(pick('upcoming')),
    },
    requests,
    recruitment: {
      upcoming: acq
        .filter((l) => l.status === 'meeting' && l.meet?.date && l.meet.date >= istYmd(P.T) && l.meet.date <= istYmd(P.T + 7 * DAY))
        .map((l) => ({ name: l.name || '', company: l.company || '', owner: l.owner || '', type: l.meet?.type || 'Meeting', at: isoOf(fromIst(l.meet.date, l.meet.time)) }))
        .sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0)),
      funnel: {
        contacted: cohort.length,
        meeting: cohort.filter(met).length,
        followup: cohort.filter((l) => l.status === 'followup').length,
        signed: cohort.filter(signed).length,
        onboarding: cohort.filter((l) => l.status === 'onboarding').length,
        rejected: cohort.filter((l) => l.status === 'rejected').length,
      },
      team: [...team.values()].sort((a, b) => b.contacted - a.contacted),
      rejectReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      agenda: more.agenda,
      recent: more.recent,
    },
    attention: {
      missingPayout: payoutMissing.length,
      missingPayoutWithDue: payoutMissing.filter((p) => p.partnerCode && owedCodes.has(p.partnerCode)).length,
      invitedNotSetUp: invited.length,
      oldestInviteDays: invited.length ? Math.max(...invited.map((p) => Math.floor((now - (ms(p.createdAt) ?? now)) / DAY))) : 0,
      noLead30d: active.filter((p) => (ms(p.createdAt) ?? now) < now - 30 * DAY && !recentLead.has(String(p._id))).length,
      signedNotOnboarding: acq.filter((l) => l.status === 'converted').length,
    },
    topPartners,
    roster: more.roster,
    newLeads: more.newLeads,
    requestKinds: more.requestKinds,
    payoutsDue: more.payoutsDue,
    weekly: Array.from({ length: WEEKS }, (_, i) => {
      const from = firstWeek + i * 7 * DAY;
      return { weekOf: new Date(from).toISOString(), value: total(within(won, from, from + 7 * DAY)).value };
    }),
  };
}

const missingPayoutDetails = (p) => !p.pan || !p.bankAccount || !p.ifsc;
const block = (list) => ({ count: list.length, list: list.slice(0, LIST_MAX) });

/**
 * Detail lists for the founder's Partner portal tab (added with the "more detail" pass):
 *  roster        every partner: leads total / open / won, won value, commission payable / paid,
 *                last activity, payout details missing (top LIST_MAX by last activity)
 *  newLeads      partner leads created in the last 7 days
 *  requestKinds  open requests per kind with the latest few
 *  payoutsDue    commission the client has paid for: payable now, or on hold (with the reason)
 *  agenda        recruitment meetings and follow-ups due within 7 days (overdue included)
 *  recent        everyone first contacted this month, newest first
 */
function details({ now, P, partners, leads, projects, rows, rowSource, requests, acq, cohort, pipe, won }) {
  const byId = new Map(partners.map((p) => [String(p._id), p]));
  const stageName = (key) => (key === WON ? 'Won' : key === LOST ? 'Lost' : pipe.stages.find((s) => s.key === key)?.name || key || '—');

  // Roster
  const stat = new Map(partners.map((p) => [String(p._id), { leads: 0, open: 0, won: 0, wonValue: 0, payable: 0, paid: 0, last: ms(p.createdAt) }]));
  const touch = (id, t) => {
    const s = stat.get(id);
    if (s && t != null && t > (s.last ?? 0)) s.last = t;
  };
  for (const l of leads) {
    const id = String(l.owner);
    const s = stat.get(id);
    if (!s) continue;
    s.leads++;
    if (l.stage !== WON && l.stage !== LOST) s.open++;
    touch(id, ms(l.updatedAt) ?? ms(l.createdAt));
    for (const a of l.activities || []) touch(id, ms(a.createdAt));
  }
  for (const w of won) {
    const s = stat.get(w.owner);
    if (s) { s.won++; s.wonValue += w.value; }
  }
  for (const pr of projects) if (pr.owner?._id) touch(String(pr.owner._id), ms(pr.updatedAt));
  for (const r of rows) {
    const s = stat.get(rowSource.get(r.id)?.ownerId);
    if (!s) continue;
    if (r.state === 'processing') s.payable += r.commission;
    if (r.state === 'released') s.paid += r.commission;
  }
  const roster = partners
    .map((p) => {
      const id = String(p._id);
      const s = stat.get(id);
      return {
        id, name: p.name, company: p.company || '', code: p.partnerCode || '', status: p.status,
        leads: s.leads, openLeads: s.open, wonLeads: s.won, wonValue: s.wonValue,
        commissionPayable: s.payable, commissionPaid: s.paid,
        lastActivityAt: isoOf(s.last ?? null), payoutDetailsMissing: missingPayoutDetails(p),
      };
    })
    .sort((a, b) => (ms(b.lastActivityAt) ?? 0) - (ms(a.lastActivityAt) ?? 0) || b.leads - a.leads || a.name.localeCompare(b.name));

  // New partner leads, last 7 days
  const partnerLabel = (id) => {
    const p = byId.get(id);
    return p ? p.company || p.name : 'Partner';
  };
  const fresh = leads
    .filter((l) => (ms(l.createdAt) ?? 0) >= now - 7 * DAY)
    .sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0))
    .map((l) => ({
      id: String(l._id), partner: partnerLabel(String(l.owner)), company: l.company || '', stage: l.stage, stageName: stageName(l.stage),
      value: l.value || 0, createdAt: isoOf(ms(l.createdAt)),
    }));

  // Requests per kind (requests are oldest first, so the latest are at the end)
  const requestKinds = REQUEST_KIND_ORDER.map((kind) => {
    const mine = requests.filter((r) => r.kind === kind);
    return {
      kind,
      open: mine.length,
      escalated: mine.filter((r) => r.escalated).length,
      oldestAt: mine[0]?.createdAt ?? null,
      latest: mine.slice(-LATEST_PER_KIND).reverse().map((r) => ({ id: r.id, title: r.title, partner: r.partner, status: r.status, createdAt: r.createdAt, scheduledAt: r.scheduledAt ?? null })),
    };
  });

  // Payouts the client has paid for: payable now, or on hold
  const holdReason = (p) => {
    if (!p) return 'Partner account removed';
    if (p.status === 'disabled') return 'Partner account disabled';
    if (missingPayoutDetails(p)) {
      const missing = [!p.pan && 'PAN', !p.bankAccount && 'bank account', !p.ifsc && 'IFSC'].filter(Boolean);
      return `${missing.join(', ')} missing`.replace(/^./, (c) => c.toUpperCase());
    }
    return null;
  };
  const payable = [];
  const onHold = [];
  for (const r of rows.filter((x) => x.state === 'processing').sort((a, b) => (ms(a.dueOn) ?? Infinity) - (ms(b.dueOn) ?? Infinity))) {
    const src = rowSource.get(r.id) || {};
    const reason = holdReason(byId.get(src.ownerId));
    const item = {
      id: r.id, partner: r.partner, company: r.company, code: r.code, client: r.client, project: src.title || '', milestone: r.label,
      amount: r.amount, commission: r.commission, clientPaidOn: r.dueOn,
    };
    if (reason) onHold.push({ ...item, reason });
    else payable.push(item);
  }
  const payBlock = (list) => ({ ...block(list), total: list.reduce((a, r) => a + r.commission, 0) });

  // Recruitment: what is booked or due in the next 7 days (overdue follow-ups included)
  const today = istYmd(P.T);
  const weekAhead = istYmd(P.T + 7 * DAY);
  const agenda = acq
    .filter((l) => ACQ_OPEN.includes(l.status))
    .map((l) => {
      const meeting = l.status === 'meeting' && l.meet?.date;
      const day = meeting ? l.meet.date : l.next;
      if (!day || day > weekAhead) return null;
      return {
        id: String(l._id), name: l.name || '', company: l.company || '', owner: l.owner || '',
        kind: meeting ? 'meeting' : 'followup', type: meeting ? l.meet?.type || 'Meeting' : ACQ_STATUS_LABEL[l.status],
        at: isoOf(fromIst(day, meeting ? l.meet?.time : null)), overdue: day < today,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
  const recent = [...cohort]
    .sort((a, b) => (b.contactedAt || '').localeCompare(a.contactedAt || '') || String(b._id).localeCompare(String(a._id)))
    .map((l) => ({
      id: String(l._id), name: l.name || '', company: l.company || '', owner: l.owner || '',
      status: ACQ_STATUS_LABEL[l.status] || l.status, contactedAt: isoOf(fromIst(l.contactedAt)),
    }));

  return {
    roster: block(roster),
    newLeads: { ...block(fresh), value: fresh.reduce((a, l) => a + l.value, 0) },
    requestKinds,
    payoutsDue: { payable: payBlock(payable), onHold: payBlock(onHold) },
    agenda: block(agenda),
    recent: block(recent),
  };
}
