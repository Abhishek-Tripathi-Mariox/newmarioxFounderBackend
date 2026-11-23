/**
 * Leads business rules — port of frontend store/slices/sales.js (setLead, logAct, bulk, saveLead,
 * mergeLead) plus list filters / CSV export from features/leads.
 * Every service function takes `ctx = { user, actor }` (user = whose permissions apply, actor = who
 * is signed in; they differ only in "Preview as").
 */
import { tx } from '../../db/mongo.js';
import { nextId } from '../../core/ids.js';
import { peopleScope } from '../../core/scope.js';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pageParams } from '../../core/http.js';
import * as repo from './leads.repository.js';
import { toActivity, toInsightFu, toInsightLead, toLead, toQuote } from './leads.mapper.js';
import { findDuplicateLeads, leadInsights } from './leads.insights.js';
import { DAY, iso, parseDay, toCsv, ymd } from './leads.util.js';
import { COMPANY_ID, DEFAULT_COMPANY } from './leads.schemas.js';
import { documentsService } from '../documents/documents.service.js';
import { toFollowUp } from '../followups/followups.mapper.js';

/* ───────────── scope helpers ───────────── */

/** Owner ids the user may see for leads (null = all). */
export async function leadPeople(user) {
  return (await peopleScope(user, 'leads')).people;
}
const inScope = (people, lead) => !people || people.includes(lead.owner_id);

/** Lead visible to the user, else 404. */
async function readable(id, user, session = null) {
  const lead = await repo.findLead(id, session);
  const people = await leadPeople(user);
  if (!lead || !inScope(people, lead)) throw notFound('Lead');
  return lead;
}

/** Lead about to be changed; 404 if missing, 403 if outside the user's scope. */
async function writable(session, id, user, people) {
  const lead = await repo.findLead(id, session);
  if (!lead) throw notFound('Lead');
  if (!inScope(people === undefined ? await leadPeople(user) : people, lead)) throw forbidden();
  return lead;
}

const actorId = (ctx) => (ctx.actor || ctx.user).id;
const act = (ctx, leadId, kind, text, at = new Date()) => ({ lead_id: leadId, kind, text, actor_user_id: actorId(ctx), at });

async function ownerNameMap(session = null) {
  const rows = await repo.salesOwners(session);
  return Object.fromEntries(rows.map((o) => [o.id, o.name]));
}
const ownerName = (map, id) => map[id] || 'Unassigned';

/** Our company a lead is for (old leads have none: Mariox). */
const companyOf = (lead) => lead.company_id || DEFAULT_COMPANY;
/** Names of the built-in Founders HQ companies; a company the founders added reads from its id ('acme-labs' → 'Acme labs'). */
const COMPANY_NAMES = { mariox: 'Mariox', hroo: 'HROO', arth: 'Arth' };
/** Our-company cell for the CSV export: a name the import understands for built-ins, else the id. */
const exportCompany = (id) => COMPANY_NAMES[id] || id;
const companyName = (id) => COMPANY_NAMES[id] || (id.replace(/-+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()) || 'Company');

/* ───────────── insights ───────────── */

/** All scoped leads with computed insights. */
async function scopedWithInsights(user, staleDays = 7, now = Date.now()) {
  const people = await leadPeople(user);
  const [rows, fuRows, stageNames, owners] = await Promise.all([
    repo.scopedLeads(people), repo.insightFollowUps(people), repo.stageNames(), ownerNameMap(),
  ]);
  const ins = leadInsights({ leads: rows.map(toInsightLead), fus: fuRows.map(toInsightFu), staleDays, now, stageNames });
  return { people, rows, ins, stageNames, owners, now };
}

/** Lead DTO + computed fields (score, hot, stale, lastContactAt, nextFollowUp, duplicateOf). */
function decorate(row, { ins, owners, now }) {
  const l = { id: row.id, status: row.status };
  const nf = ins.nextOf[row.id];
  return {
    ...toLead(row),
    ownerName: ownerName(owners, row.owner_id),
    score: ins.scoreOf[row.id],
    hot: ins.isHot(l),
    stale: ins.isStale(l),
    daysSinceContact: ins.daysSince(row.id),
    lastContactAt: iso(ins.touch[row.id]),
    nextFollowUp: nf ? { id: nf.id, type: nf.type, title: nf.title, dueAt: iso(nf.dueMs), overdue: nf.dueMs < now } : null,
    duplicateOf: ins.dupOf[row.id] || null,
  };
}

/* ───────────── list / export ───────────── */

function applyFilters(rows, f, ins) {
  const from = parseDay(f.from);
  const to = f.to ? parseDay(f.to) + DAY : null;
  const q = (f.q || '').toLowerCase();
  return rows.filter((l) => {
    const created = new Date(l.created_at).getTime();
    const s = { id: l.id, status: l.status };
    return (from == null || created >= from) && (to == null || created < to)
      && (!f.status || l.status === f.status)
      && (!f.owner || l.owner_id === f.owner)
      && (!f.source || l.source === f.source)
      && (!f.service || (l.services || []).includes(f.service))
      && (!f.company || companyOf(l) === f.company)
      && (!q || `${l.company} ${l.contact} ${l.email} ${l.id}`.toLowerCase().includes(q))
      && (!f.flag || (f.flag === 'hot' ? ins.isHot(s) : f.flag === 'stale' ? ins.isStale(s) : !!ins.dupOf[l.id]));
  });
}

function sortRows(rows, sort, { ins, owners, stageNames }) {
  const desc = !sort || sort.startsWith('-');
  const k = sort ? sort.replace(/^-/, '') : 'created';
  const keyOf = {
    score: (l) => ins.scoreOf[l.id],
    created: (l) => new Date(l.created_at).getTime(),
    updated: (l) => new Date(l.updated_at).getTime(),
    value: (l) => Number(l.value),
    company: (l) => l.company.toLowerCase(),
    contact: (l) => l.contact.toLowerCase(),
    status: (l) => stageNames.indexOf(l.status),
    owner: (l) => ownerName(owners, l.owner_id).toLowerCase(),
    next: (l) => (ins.nextOf[l.id] ? ins.nextOf[l.id].dueMs : Infinity),
    lastContact: (l) => ins.touch[l.id],
    id: (l) => Number(l.id.slice(3)),
  }[k] || ((l) => new Date(l.created_at).getTime());
  const d = desc ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    if (x > y) return d;
    if (x < y) return -d;
    return b.id.localeCompare(a.id, 'en', { numeric: true });
  });
}

const groupBy = (rows, key, ids, map) => {
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const r of rows) (out[r[key]] ||= []).push(map(r));
  return out;
};

/** ?include=activities,quotes,documents → embed those arrays (one query per kind for the whole page). */
async function embed(items, include = []) {
  if (!include.length || !items.length) return items;
  const ids = items.map((l) => l.id);
  const [acts, quotes, docs] = await Promise.all([
    include.includes('activities') ? repo.activitiesOfMany(ids).then((r) => groupBy(r, 'lead_id', ids, toActivity)) : null,
    include.includes('quotes') ? repo.quotesOfMany(ids).then((r) => groupBy(r, 'lead_id', ids, toQuote)) : null,
    include.includes('documents') ? documentsService.listForMany('lead', ids) : null,
  ]);
  return items.map((l) => ({
    ...l,
    ...(acts && { activities: acts[l.id] }),
    ...(quotes && { quotes: quotes[l.id] }),
    ...(docs && { documents: docs[l.id] }),
  }));
}

export async function list(query, ctx) {
  const S = await scopedWithInsights(ctx.user, query.staleDays);
  const shown = sortRows(applyFilters(S.rows, query, S.ins), query.sort, S);
  const p = pageParams(query);
  const items = shown.slice(p.offset, p.offset + p.limit).map((r) => decorate(r, S));
  return { items: await embed(items, query.include), meta: p.meta(shown.length) };
}

/** CSV with the same columns as the frontend exportLeadsCsv (filters + scope applied, no paging). */
export async function exportCsv(query, ctx) {
  const S = await scopedWithInsights(ctx.user, query.staleDays);
  let shown = sortRows(applyFilters(S.rows, query, S.ins), query.sort, S);
  if (query.ids) { const want = new Set(query.ids); shown = shown.filter((l) => want.has(l.id)); }
  // "Our company" is last so older columns keep their place; it is the same column the import reads
  // (built-in companies by name, companies added in Founders HQ by id), so an export can be re-imported.
  const cols = ['ID', 'Company', 'Contact', 'Email', 'Phone', 'Service', 'Source', 'Owner', 'Stage', 'Value (INR)', 'Score', 'Created', 'Last contact', 'Our company'];
  const rows = shown.map((l) => [
    l.id, l.company, l.contact, l.email, l.phone, (l.services || []).join(', '), l.source, ownerName(S.owners, l.owner_id), l.status, Number(l.value),
    S.ins.scoreOf[l.id], ymd(l.created_at), ymd(S.ins.touch[l.id] ?? l.created_at), exportCompany(companyOf(l)),
  ]);
  return { csv: toCsv([cols, ...rows]), filename: `mariox-leads-${ymd(Date.now())}.csv`, count: shown.length };
}

/* ───────────── detail ───────────── */

export async function get(id, ctx) {
  await readable(id, ctx.user);
  const S = await scopedWithInsights(ctx.user);
  const row = S.rows.find((r) => r.id === id);
  const [acts, quotes, docs, fus] = await Promise.all([
    repo.activitiesOf(id), repo.quotesOf(id), documentsService.listFor('lead', id), repo.followUpsOf(id),
  ]);
  return {
    ...decorate(row, S),
    activities: acts.map(toActivity),
    quotes: quotes.map(toQuote),
    documents: docs,
    followUps: fus.map((f) => toFollowUp(f, row)),
  };
}

/* ───────────── create / update ───────────── */

function checkLeadForm(m) {
  if (!m.company.trim() || !m.contact.trim()) throw unprocessable('Company and contact person are required.');
  if (!m.services.length) throw unprocessable('Pick at least one service.');
}

async function checkOwner(id, session) {
  if (!(await repo.ownerById(id, session))) throw unprocessable('Pick a valid owner.');
}
async function checkSource(name, session) {
  if (name && !(await repo.sourceExists(name, session))) throw unprocessable('Pick a valid source.');
}
async function checkStage(name, session) {
  if (!(await repo.stageExists(name, session))) throw unprocessable('Pick a valid stage.');
}

export async function create(body, ctx) {
  const { user } = ctx;
  checkLeadForm(body);
  return tx(async (session) => {
    const { scope } = await peopleScope(user, 'leads');
    let owner = body.ownerId || user.ownerId;
    // A Sales Executive (own scope) always creates leads for themselves.
    if (scope === 'own') {
      if (!user.ownerId) throw forbidden('Your account has no sales profile');
      owner = user.ownerId;
    }
    if (!owner) owner = (await repo.firstOwner(session))?.id;
    await checkOwner(owner, session);
    const source = body.source || (await repo.sourceNames(session))[0] || null;
    await checkSource(source, session);
    const row = await repo.insertLead({
      id: await nextId('lead'),
      company: body.company.trim(),
      contact: body.contact.trim(),
      email: body.email.trim(),
      phone: body.phone.trim(),
      services: body.services,
      source,
      owner_id: owner,
      first_owner_id: owner,
      status: 'New',
      value: +body.value || 0,
      notes: body.notes,
      company_id: body.companyId || DEFAULT_COMPANY,
    }, session);
    return row.id;
  }).then((id) => get(id, ctx));
}

/**
 * CSV import. Each row: company and / or contact (one is required; the other copies it), email, phone,
 * services ("A; B", optional), source, owner (sales person's name or email; spaces / case ignored),
 * status (a pipeline stage; default New), value, notes, companyId (our company: an HQ company id or a
 * built-in company's name; empty = Mariox). An unknown source / status / owner / company doesn't fail
 * the row: the default is used, a warning is returned and the original value is kept in the notes.
 * Rows with real problems (no name, bad email / value) are reported with their row number (row 2 = first data row).
 * Rows whose email or phone already belongs to a lead are skipped unless skipDuplicates is false.
 */
export async function importLeads({ rows, skipDuplicates }, ctx) {
  const { user } = ctx;
  const errors = [];
  const warnings = [];
  const skipped = [];
  const ids = [];
  await tx(async (session) => {
    const { scope } = await peopleScope(user, 'leads');
    if (scope === 'own' && !user.ownerId) throw forbidden('Your account has no sales profile');
    const [stages, sources, owners, users] = await Promise.all([
      repo.stageNames(session), repo.sourceNames(session), repo.allOwners(session), repo.ownerUsers(session),
    ]);
    const lc = (s) => String(s || '').trim().toLowerCase();
    const findIn = (list, v) => list.find((x) => lc(x) === lc(v)) || list.find((x) => lc(x).replace(/[^a-z0-9]/g, '') === lc(v).replace(/[^a-z0-9]/g, ''));
    const squash = (x) => lc(x).replace(/[^a-z0-9@.]/g, '');
    const ownerOf = (v) => {
      if (!v) return null;
      const byName = owners.find((o) => lc(o.name) === lc(v)) || owners.find((o) => squash(o.name) === squash(v));
      if (byName) return byName.id;
      const byMail = users.find((u) => lc(u.email) === lc(v));
      return byMail ? byMail.owner_id : undefined;
    };
    const defOwner = user.ownerId || (owners.find((o) => o.active) || {}).id;
    /** CSV company cell → company id ('' → Mariox; a built-in name or a valid id), or null when it isn't one. */
    const companyIdOf = (v) => {
      if (!v) return DEFAULT_COMPANY;
      const byName = Object.keys(COMPANY_NAMES).find((id) => lc(COMPANY_NAMES[id]) === lc(v));
      if (byName) return byName;
      const id = lc(v).replace(/\s+/g, '-');
      return COMPANY_ID.test(id) ? id : null;
    };
    const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
    const existing = await repo.leadContacts(session);
    const seenEmail = new Map(existing.filter((l) => l.email).map((l) => [lc(l.email), l.id]));
    const seenPhone = new Map(existing.filter((l) => digits(l.phone).length >= 7).map((l) => [digits(l.phone), l.id]));

    for (const [i, r] of rows.entries()) {
      const n = i + 2; // spreadsheet row number (row 1 = headers)
      if (Object.values(r).every((v) => !v)) continue; // blank line
      const fail = (msg) => errors.push({ row: n, company: r.company || r.contact, error: msg });
      const notes = [];
      const warn = (msg, keep) => { warnings.push({ row: n, company: r.company || r.contact, warning: msg }); if (keep) notes.push(keep); };
      if (!r.company && !r.contact) { fail('Add a company or a contact name.'); continue; }
      const company = r.company || r.contact;
      const contact = r.contact || r.company;
      if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) { fail(`"${r.email}" is not a valid email.`); continue; }
      const services = r.services.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
      let source = r.source ? findIn(sources, r.source) : sources[0] || null;
      if (r.source && !source) {
        source = sources[0] || null;
        warn(`Source "${r.source}" isn't in Lead setup — used ${source || 'none'}.`, `Imported source: ${r.source}`);
      }
      let status = r.status ? findIn(stages, r.status) : 'New';
      if (!status) {
        status = stages.includes('New') ? 'New' : stages[0];
        warn(`Status "${r.status}" isn't a pipeline stage — put in ${status}.`, `Imported status: ${r.status}`);
      }
      let owner = scope === 'own' ? user.ownerId : ownerOf(r.owner);
      if (owner === undefined) {
        warn(`Owner "${r.owner}" isn't a sales person — assigned to you / the default owner.`, `Imported owner: ${r.owner}`);
        owner = null;
      }
      owner = owner || defOwner;
      if (!owner) { fail('No sales person to own this lead.'); continue; }
      const companyId = companyIdOf(r.companyId);
      if (!companyId) warn(`Company "${r.companyId}" isn't one of ours — put in ${companyName(DEFAULT_COMPANY)}.`, `Imported company: ${r.companyId}`);
      const value = r.value ? Number(String(r.value).replace(/[₹,\s]/g, '')) : 0;
      if (!Number.isFinite(value) || value < 0) { fail(`Value "${r.value}" is not a number.`); continue; }
      const dup = (r.email && seenEmail.get(lc(r.email))) || (digits(r.phone).length >= 7 && seenPhone.get(digits(r.phone)));
      if (dup && skipDuplicates) { skipped.push({ row: n, company, duplicateOf: dup }); continue; }
      const allNotes = [r.notes, ...notes].filter(Boolean).join('\n');
      r.company = company; r.contact = contact; r.notes = allNotes; r.services = services;

      const id = await nextId('lead');
      await repo.insertLead({
        id, company: r.company, contact: r.contact, email: r.email, phone: r.phone, services: r.services, source,
        owner_id: owner, first_owner_id: owner, status, value, notes: r.notes, company_id: companyId || DEFAULT_COMPANY,
      }, session);
      await repo.addActivities([act(ctx, id, 'note', 'Imported from CSV')], session);
      if (r.email) seenEmail.set(lc(r.email), id);
      if (digits(r.phone).length >= 7) seenPhone.set(digits(r.phone), id);
      ids.push(id);
    }
  });
  return { created: ids.length, ids, skipped, errors, warnings };
}

/** Apply a stage change; records "Stage: A → B". */
async function setStatusTx(session, lead, to, ctx) {
  if (lead.status === to) return lead;
  await checkStage(to, session);
  const row = await repo.updateLead(lead.id, { status: to }, session);
  await repo.addActivities([act(ctx, lead.id, 'status', `Stage: ${lead.status} → ${to}`)], session);
  return row;
}

/** Apply an owner transfer; keeps first_owner and records "Transferred A → B". */
async function setOwnerTx(session, lead, to, ctx, owners) {
  if (lead.owner_id === to) return lead;
  if (!owners[to]) throw unprocessable('Pick a valid owner.');
  const row = await repo.updateLead(lead.id, { owner_id: to, first_owner_id: lead.first_owner_id || lead.owner_id }, session);
  await repo.addActivities([act(ctx, lead.id, 'owner', `Transferred ${ownerName(owners, lead.owner_id)} → ${ownerName(owners, to)}`)], session);
  return row;
}

export async function update(id, body, ctx) {
  await tx(async (session) => {
    let lead = await writable(session, id, ctx.user);
    const m = {
      company: body.company ?? lead.company, contact: body.contact ?? lead.contact, services: body.services ?? lead.services,
    };
    checkLeadForm(m);
    if (body.source !== undefined) await checkSource(body.source, session);
    // Validate the stage / owner change too before the first write (no rollback on a standalone server).
    if (body.status !== undefined && body.status !== lead.status) await checkStage(body.status, session);
    const owners = body.ownerId !== undefined ? await ownerNameMap(session) : null;
    if (owners && body.ownerId !== lead.owner_id && !owners[body.ownerId]) throw unprocessable('Pick a valid owner.');
    const patch = {};
    if (body.company !== undefined) patch.company = body.company.trim();
    if (body.contact !== undefined) patch.contact = body.contact.trim();
    if (body.email !== undefined) patch.email = body.email.trim();
    if (body.phone !== undefined) patch.phone = body.phone.trim();
    if (body.services !== undefined) patch.services = body.services;
    if (body.source !== undefined) patch.source = body.source;
    if (body.value !== undefined) patch.value = +body.value || 0;
    if (body.notes !== undefined) patch.notes = body.notes;
    const companyChange = body.companyId !== undefined && body.companyId !== companyOf(lead)
      ? act(ctx, id, 'company', `Company: ${companyName(companyOf(lead))} → ${companyName(body.companyId)}`) : null;
    if (companyChange) patch.company_id = body.companyId;
    if (Object.keys(patch).length) lead = await repo.updateLead(id, patch, session);
    if (companyChange) await repo.addActivities([companyChange], session);
    if (body.status !== undefined) lead = await setStatusTx(session, lead, body.status, ctx);
    if (owners) await setOwnerTx(session, lead, body.ownerId, ctx, owners);
  });
  return get(id, ctx);
}

export async function setStatus(id, status, ctx) {
  await tx(async (session) => setStatusTx(session, await writable(session, id, ctx.user), status, ctx));
  return get(id, ctx);
}

export async function setOwner(id, ownerId, ctx) {
  await tx(async (session) => setOwnerTx(session, await writable(session, id, ctx.user), ownerId, ctx, await ownerNameMap(session)));
  // A transfer can move the lead out of the user's own scope — return the plain lead then.
  try {
    return await get(id, ctx);
  } catch {
    return toLead(await repo.findLead(id));
  }
}

export async function addActivity(id, { kind, text }, ctx) {
  await tx(async (session) => {
    await writable(session, id, ctx.user);
    await repo.addActivities([act(ctx, id, kind, text)], session);
  });
  return (await repo.activitiesOf(id)).map(toActivity);
}

/** Apply owner or status to many leads (frontend bulk). Every lead is checked before the first change. */
export async function bulk({ ids, owner, status }, ctx) {
  const unique = Array.from(new Set(ids));
  await tx(async (session) => {
    const people = await leadPeople(ctx.user);
    const owners = await ownerNameMap(session);
    if (owner && !owners[owner]) throw unprocessable('Pick a valid owner.');
    if (status) await checkStage(status, session);
    const leads = [];
    for (const id of unique) leads.push(await writable(session, id, ctx.user, people));
    for (const lead of leads) {
      if (owner) await setOwnerTx(session, lead, owner, ctx, owners);
      else await setStatusTx(session, lead, status, ctx);
    }
  });
  const owners = owner ? await ownerNameMap() : {};
  return {
    ids: unique,
    count: unique.length,
    message: `${unique.length} leads ${owner ? `assigned to ${ownerName(owners, owner)}` : `moved to ${status}`}`,
  };
}

/** Merge dropId into keepId: contact info, notes, documents, quotes, activity, follow-ups (frontend mergeLead). */
export async function merge({ keepId, dropId }, ctx) {
  await tx(async (session) => {
    const people = await leadPeople(ctx.user);
    const k = await writable(session, keepId, ctx.user, people);
    const d = await writable(session, dropId, ctx.user, people);
    await repo.updateLead(keepId, {
      email: k.email || d.email,
      phone: k.phone || d.phone,
      notes: [k.notes, d.notes].filter(Boolean).join('\n\n'),
    }, session);
    await repo.moveChildren(dropId, keepId, session);
    await documentsService.reassign('lead', dropId, keepId, session);
    await repo.addActivities([act(ctx, keepId, 'note', `Merged ${d.id} (${d.company}) into this lead`)], session);
    await repo.deleteLead(dropId, session);
  });
  return get(keepId, ctx);
}

/** Up to 3 visible leads that look like the given details (lead modal warning). */
export async function duplicates(query, ctx) {
  const people = await leadPeople(ctx.user);
  const rows = await repo.scopedLeads(people);
  return findDuplicateLeads(query, rows, query.excludeId).map(toLead);
}

export async function remove(id, ctx) {
  const unlinkFiles = await tx(async (session) => {
    await writable(session, id, ctx.user);
    const unlink = await documentsService.removeForEntity('lead', id, session);
    await repo.deleteLead(id, session);
    return unlink;
  });
  await unlinkFiles();
}

/* ───────────── documents ───────────── */

export async function uploadDocuments(id, files, ctx) {
  try {
    if (!files || !files.length) throw unprocessable('Choose at least one file.');
    return await tx(async (session) => {
      await writable(session, id, ctx.user);
      return documentsService.attach('lead', id, files, ctx.actor || ctx.user, session);
    });
  } catch (e) {
    await documentsService.discard(files);
    throw e;
  }
}

export const _internal = { readable, writable, act, ownerNameMap, ownerName, setStatusTx };
