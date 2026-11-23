import { z } from 'zod';
import { PpAcqLead, PpSetting, PpUser } from '../../../db/models/index.js';
import { tx } from '../../../db/mongo.js';
import { nextCode } from '../lib/codes.js';
import { DEFAULT_COMMISSION_RATE } from '../lib/constants.js';
import { PpError } from '../lib/http.js';
import { createPartner } from '../lib/users.js';
import { R, all, formatPhone, istToday, notPast, parsePhone, slotError } from '../lib/validate.js';
import {
  ACQ_LIST_KEYS, HOME, OPEN, OPTS, STATUS_LABEL, add, dayOf, fdt, isUrl, listsWithDefaults, t12, withScheme,
} from './acquisition.rules.js';
import { sampleLeads } from './acquisition.samples.js';

/**
 * Partner acquisition, admin only (mariox-saas src/lib/acquisition-server.ts and
 * src/app/api/admin/acquisition/**). The page filters and measures in the browser; the server keeps
 * the status rules: which step is allowed from which status, meeting slots ahead of now (IST),
 * follow-ups not in the past, convert → partner account, reject needs a reason.
 */

const POPULATE_PARTNER = { path: 'partner', select: 'name partnerCode status' };

/* ------------------------------------------------------------------ lists and team emails */
export async function getLists() {
  const doc = await PpSetting.findOne({ key: 'portal' }).select('acquisition').lean();
  const emails = doc?.acquisition?.emails ?? {};
  return { lists: listsWithDefaults(doc?.acquisition), emails: { ...(emails instanceof Map ? Object.fromEntries(emails) : emails) } };
}

async function saveLists(lists) {
  const clean = Object.fromEntries(ACQ_LIST_KEYS.map((k) => [k, [...new Set(lists[k].map((v) => v.trim()).filter(Boolean))]]));
  // Each list on its own, so the team emails stored next to them are kept.
  await PpSetting.updateOne({ key: 'portal' }, { $set: Object.fromEntries(Object.entries(clean).map(([k, v]) => [`acquisition.${k}`, v])) }, { upsert: true });
  return listsWithDefaults(clean);
}

async function saveEmails(emails) {
  const clean = Object.fromEntries(Object.entries(emails).map(([k, v]) => [k, v.trim().toLowerCase()]).filter(([, v]) => v));
  await PpSetting.updateOne({ key: 'portal' }, { $set: { 'acquisition.emails': clean } }, { upsert: true });
  return clean;
}

export async function saveSettings({ lists, emails }) {
  return {
    ...(lists ? { lists: await saveLists(lists) } : {}),
    ...(emails ? { emails: await saveEmails(emails) } : {}),
  };
}

/* ------------------------------------------------------------------ leads */
const newCode = () => nextCode(PpAcqLead, 'code', 'P', 4, 1);

const exact = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
/** Same name + company (case-insensitive) = the same person. */
const findDuplicate = (name, company) =>
  PpAcqLead.findOne({ name: exact(name), company: company ? exact(company) : { $in: [null, ''] } }).select('name status').lean();

/** Lead as the page expects it: string ids, converted partner populated, no timestamps. */
function toClient(r) {
  const { __v, createdAt, updatedAt, ...rest } = r;
  void __v; void createdAt; void updatedAt;
  const p = r.partner;
  const partner = p && typeof p === 'object' && 'name' in p ? { _id: String(p._id), name: p.name, partnerCode: p.partnerCode, status: p.status } : p ? String(p) : null;
  return { ...rest, _id: String(r._id), partner };
}

export async function loadLead(id) {
  const r = await PpAcqLead.findById(id).populate(POPULATE_PARTNER).lean().catch(() => null);
  if (!r) throw new PpError(404, 'Lead not found');
  return toClient(r);
}

export async function list() {
  const [rows, { lists, emails }] = await Promise.all([
    PpAcqLead.find().sort({ _id: -1 }).populate(POPULATE_PARTNER).lean(),
    getLists(),
  ]);
  return { leads: rows.map(toClient), lists, emails, rate: Math.round(DEFAULT_COMMISSION_RATE * 100) };
}

/* ------------------------------------------------------------------ meetings */
/** A meeting being booked or moved has to be ahead of now (IST). */
function slotCheck(m, what = 'The meeting time') {
  if (!m?.date) return;
  const e = slotError(m.date, m.time ?? '', what);
  if (e) throw new PpError(400, e);
}
/** A booked meeting as stored; `invited` resets whenever the meeting is (re)booked. */
const toMeet = (m, fallbackDate, invited = false) => ({ ...m, date: m.date || fallbackDate, time: m.time || '16:00', invited });

/** First steps for a new lead: with a meeting date it starts in Meeting, otherwise as a Lead with a next step. */
function startLead(r, code) {
  const t = dayOf(r.today);
  const { next, meet, force, today, ...fields } = r;
  void force; void today;
  const l = { ...fields, linkedin: withScheme(fields.linkedin), code, status: 'contacted', steps: [{ k: 'contacted', date: r.contactedAt, note: `Contacted on ${r.channel}` }], meet: { duration: 30, attendees: [] } };
  if (meet?.date) {
    slotCheck(meet);
    l.status = 'meeting';
    l.meet = toMeet({ ...meet, attendees: meet.attendees.length ? meet.attendees : [r.owner].filter(Boolean) }, add(t, 1));
    l.steps.push({ k: 'meeting', date: t, note: `${l.meet.type} on ${fdt(l.meet.date)} ${t12(l.meet.time)}` });
  } else {
    const e = next ? notPast(next, 'Next step') : null;
    if (e) throw new PpError(400, e);
    l.next = next || add(t, 1);
  }
  return l;
}

/** Add a lead; the same name + company is refused (409) unless `force`. */
export async function create(r) {
  if (!r.force) {
    const dup = await findDuplicate(r.name, r.company);
    if (dup) throw new PpError(409, `${dup.name} is already here (${STATUS_LABEL[dup.status] ?? dup.status}). Save again to add anyway.`);
  }
  const doc = await PpAcqLead.create(startLead(r, await newCode()));
  return loadLead(String(doc._id));
}

/** Edit details. An open lead given a meeting date moves to Meeting; a changed date or time needs a new invite. */
function editLead(l, fields, meet, t) {
  Object.assign(l, { ...fields, linkedin: withScheme(fields.linkedin) });
  const c = l.steps.find((s) => s.k === 'contacted');
  if (c) c.date = fields.contactedAt;
  if (!meet?.date || !OPEN.includes(l.status)) return false;
  const changed = l.status !== 'meeting' || l.meet?.date !== meet.date || l.meet?.time !== meet.time;
  if (changed) slotCheck(meet);
  l.meet = toMeet({ ...meet, attendees: meet.attendees.length ? meet.attendees : [l.owner].filter(Boolean) }, meet.date, changed ? false : !!l.meet?.invited);
  if (l.status !== 'meeting') {
    l.status = 'meeting';
    l.steps.push({ k: 'meeting', date: t, note: `${l.meet.type} on ${fdt(l.meet.date)} ${t12(l.meet.time)}` });
  }
  return changed;
}

/** Converted → onboarding (the partner account was created when they converted). */
function startOnboarding(l, t) {
  if (l.status !== 'converted') throw new PpError(400, 'Only converted leads can start onboarding');
  l.status = 'onboarding';
  l.onboardAt = t;
  l.steps.push({ k: 'onboarding', date: t, note: 'Onboarding started in Partners' });
}

/** Converted → a partner account (invited, 7-day link). An existing partner with the email is linked instead. */
async function makePartner(l, email, commissionRate, session) {
  const existing = await PpUser.findOne({ email: email.toLowerCase() }).select('role name partnerCode').session(session).lean();
  if (existing) {
    if (existing.role !== 'partner') throw new PpError(409, `${email} belongs to an admin account`);
    return { id: String(existing._id), code: existing.partnerCode, setPasswordUrl: null, linked: true };
  }
  const r = await createPartner(
    { name: l.name, email, phone: l.phone || undefined, company: l.company || undefined, city: [l.city, l.country].filter(Boolean).join(', ') || undefined, commissionRate },
    'acquisition',
    session,
  );
  return { id: String(r.user.id), code: r.user.partnerCode, setPasswordUrl: r.setPasswordUrl, linked: false };
}

/** The update dialog: applies the picked option to the lead. Every check runs before the partner account is created. */
async function applyUpdate(l, u, session) {
  const t = dayOf(u.today);
  const k = u.opt;
  const note = u.note.trim();
  if (!(OPTS[l.status] || []).includes(k)) throw new PpError(400, 'That step is not available for this lead. Reopen it first.');
  if (u.temp) l.temp = u.temp;
  const steps = l.steps;
  let partner = null;

  if (k === 'meet' || k === 'move') slotCheck(u.meet ?? { date: add(t, 1) });
  if ((k === 'done' || k === 'again' || k === 'later') && u.next) { const e = notPast(u.next, 'Next follow-up'); if (e) throw new PpError(400, e); }
  if (k === 'convert' && u.convertedAt && u.convertedAt > istToday()) throw new PpError(400, "Signed on can't be in the future");
  if (k === 'meet' || k === 'move') {
    const was = l.meet?.date;
    const missed = k === 'move' && u.why !== 'moved';
    l.meet = u.meet ? toMeet(u.meet, add(t, 1)) : { ...l.meet, date: add(t, 1), invited: false };
    l.status = 'meeting';
    steps.push({
      k: k === 'move' ? 'moved' : 'meeting',
      date: k === 'move' && was && was <= t ? was : t,
      missed,
      note: [missed ? 'Missed: they didn’t join' : k === 'move' ? 'Rescheduled' : '', `New meeting ${fdt(l.meet.date)}${l.meet.time ? ` ${l.meet.time}` : ''}`, l.meet.attendees?.length ? `Attending: ${l.meet.attendees.join(', ')}` : '', note].filter(Boolean).join(' · '),
    });
  }
  if (k === 'done' || k === 'again' || k === 'later') {
    const nx = u.next || add(t, 3);
    if (k === 'done') steps.push({ k: 'done', date: l.meet?.date && l.meet.date <= t ? l.meet.date : t, note });
    else if (k === 'again' || note) steps.push({ k: 'followup', date: t, note });
    l.status = k === 'later' ? 'contacted' : 'followup';
    l.next = nx;
  }
  if (k === 'convert') {
    const email = (u.email || l.email || '').trim();
    if (!z.string().email().safeParse(email).success) throw new PpError(400, 'Add their email: it is their partner login');
    const wasMeet = l.status === 'meeting';
    const fromContacted = l.status === 'contacted';
    l.email = email;
    l.convertedAt = u.convertedAt || t;
    partner = await makePartner(l, email, u.commissionRate, session);
    l.status = 'converted';
    l.next = '';
    // Counts as a meeting held, except when they signed straight from Contacted without one.
    if (wasMeet || (!fromContacted && !steps.some((s) => s.k === 'done'))) steps.push({ k: 'done', date: l.convertedAt, note: '' });
    steps.push({ k: 'converted', date: l.convertedAt, note });
    l.partner = partner.id;
  }
  if (k === 'reject') {
    if (!u.reason) throw new PpError(400, 'Pick a reason. It shows in “Why rejected”');
    l.reason = u.reason;
    l.rejectedAt = t;
    l.status = 'rejected';
    l.next = '';
    steps.push({ k: 'rejected', date: t, reason: l.reason, note });
  }
  l.steps = steps;
  return partner;
}

/**
 * PATCH actions: update (the dialog) · edit · invited · onboard · temp · notes · reopen.
 * → { lead, partner, needsInvite }
 */
export async function patch(id, p) {
  const l = await loadLead(id);
  let partner = null;
  let needsInvite = false;
  if (p.action === 'edit') needsInvite = editLead(l, p.lead, p.meet, dayOf(p.today));
  if (p.action === 'invited' && l.meet) l.meet.invited = true;
  if (p.action === 'onboard') startOnboarding(l, dayOf(p.today));
  if (p.action === 'temp') l.temp = p.temp;
  if (p.action === 'notes') l.notes = p.notes;
  if (p.action === 'reopen') {
    const t = dayOf(p.today);
    l.status = l.steps.some((s) => s.k === 'done') ? 'followup' : 'contacted';
    l.next = add(t, 1);
    l.reason = '';
    l.steps.push({ k: 'followup', date: t, note: 'Reopened' });
  }
  // Converting creates the partner account and updates the lead together. The lead is cloned per
  // attempt so a retried transaction starts from the same state.
  await tx(async (session) => {
    const lead = structuredClone(l);
    if (p.action === 'update') partner = await applyUpdate(lead, p, session);
    const { _id, code, partner: linked, ...rest } = lead;
    void _id; void code;
    const ref = typeof linked === 'object' && linked ? linked._id : linked;
    await PpAcqLead.updateOne({ _id: id }, { $set: { ...rest, ...(ref ? { partner: ref } : {}) } }, { session });
  });
  return { lead: await loadLead(id), partner, needsInvite };
}

export async function remove(id) {
  await PpAcqLead.deleteOne({ _id: id });
}

/* ------------------------------------------------------------------ sample data and import */
export async function sample({ action, today }) {
  if (action === 'clear') return { removed: (await PpAcqLead.deleteMany({ sample: true })).deletedCount };
  const have = new Set((await PpAcqLead.find({ sample: true }).select('code').lean()).map((l) => l.code));
  // Inserted last-first so the newest-first list shows them in the listed order.
  const missing = sampleLeads(dayOf(today)).filter((l) => !have.has(l.code)).reverse();
  if (missing.length) await PpAcqLead.insertMany(missing);
  return { added: missing.length };
}

/**
 * Rows mapped from a CSV / Excel file in the browser. Rows breaking the add-form rules are reported
 * (first 20), duplicates (same name + company) skipped, rows with a meeting date start in Meeting.
 */
export async function importRows({ rows, today }) {
  const t = today && /^\d{4}-\d\d-\d\d$/.test(today) ? today : dayOf();
  const team = (await getLists()).lists.team;
  const next = Number(/\d+$/.exec(await newCode())[0]);
  const docs = [];
  const seen = new Set();
  const invalid = [];
  for (const [n, r] of rows.entries()) {
    const bad = all(R.person)(r.name) ?? R.phone(r.phone) ?? R.email(r.email) ?? R.city(r.city) ?? R.company(r.company) ?? R.date(r.cdate) ?? R.date(r.mdate);
    if (bad) { invalid.push(`Row ${n + 2} (${r.name}): ${bad}`); continue; }
    if (r.phone) { const ph = parsePhone(r.phone); r.phone = formatPhone(ph.country, ph.digits); }
    const key = `${r.name.toLowerCase()}|${r.company.toLowerCase()}`;
    if (seen.has(key) || (await findDuplicate(r.name, r.company))) continue;
    seen.add(key);
    const cd = r.cdate || t;
    const md = r.mdate;
    docs.push({
      code: `P-${String(next + docs.length).padStart(4, '0')}`,
      name: r.name, company: r.company, source: r.source || 'LinkedIn', channel: r.channel || 'LinkedIn', owner: r.owner || team[0], email: r.email, phone: r.phone, linkedin: r.linkedin, notes: r.notes,
      country: r.country || HOME, city: r.city, services: [], temp: 'warm', contactedAt: cd,
      status: md ? 'meeting' : 'contacted',
      meet: md ? { date: md, time: r.mtime, link: isUrl(r.mlink) ? r.mlink : '', duration: 30, attendees: [] } : { duration: 30, attendees: [] },
      next: md ? '' : add(t, 1),
      steps: [{ k: 'contacted', date: cd }, ...(md ? [{ k: 'meeting', date: cd, note: `Imported with meeting ${fdt(md)}` }] : [])],
    });
  }
  if (docs.length) await PpAcqLead.insertMany(docs);
  return { imported: docs.length, skipped: rows.length - docs.length - invalid.length, invalid: invalid.slice(0, 20), invalidCount: invalid.length };
}
