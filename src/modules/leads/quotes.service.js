/**
 * Quotes on a lead — port of frontend saveQuote / setQuote / printQuote.
 * Totals (net, total) are always computed server-side with qTotals.
 */
import { tx } from '../../db/mongo.js';
import { notFound, unprocessable } from '../../core/errors.js';
import * as repo from './leads.repository.js';
import { toQuote, quoteModel } from './leads.mapper.js';
import { qTotals, printQuote } from './quotes.domain.js';
import { money } from './leads.util.js';
import { _internal as L } from './leads.service.js';

const EARLY = ['New', 'Contacted', 'Qualified'];

/** Next free quote id of a lead: Q-<lead number>-<n>. */
async function nextQuoteId(session, lead) {
  const prefix = `Q-${lead.id.slice(3)}-`;
  const ids = await repo.quoteIdsStartingWith(prefix, session);
  const n = ids.reduce((a, id) => Math.max(a, +id.slice(prefix.length) || 0), 0) + 1;
  return `${prefix}${n}`;
}

/** "Sent quote …" + (early stage) "Stage: X → Proposal Sent"; mutates nothing, returns activity rows. */
async function sendSideEffects(session, lead, quoteId, ctx, base) {
  const acts = [L.act(ctx, lead.id, 'quote', `Sent quote ${quoteId} to ${lead.email || lead.contact}`, new Date(base + 1))];
  if (EARLY.includes(lead.status)) {
    await repo.updateLead(lead.id, { status: 'Proposal Sent' }, session);
    acts.push(L.act(ctx, lead.id, 'status', `Stage: ${lead.status} → Proposal Sent`, new Date(base + 2)));
  }
  return acts;
}

/** Create (qid null) or update a quote; `send` also marks it Sent. */
export async function saveQuote(leadId, qid, m, ctx) {
  const saved = await tx(async (session) => {
    const lead = await L.writable(session, leadId, ctx.user);
    const old = qid ? await repo.findQuote(leadId, qid, session) : null;
    if (qid && !old) throw notFound('Quote');
    const prev = old ? quoteModel(old) : null;
    const rawItems = m.items ?? prev?.items ?? [];
    const items = rawItems.filter((i) => String(i.d || '').trim() && +i.r > 0).map((i) => ({ d: String(i.d).trim(), q: +i.q || 0, r: +i.r }));
    if (!items.length) throw unprocessable('Add at least one line with a description and a rate.');
    const q = {
      items,
      disc: +(m.discountPct ?? prev?.disc ?? 0) || 0,
      gst: m.gst ?? prev?.gst ?? true,
      valid: +(m.validDays ?? prev?.valid ?? 15) || 15,
      terms: m.terms ?? prev?.terms ?? '',
    };
    const t = qTotals(q);
    const now = Date.now();
    const row = {
      items: q.items, discount_pct: q.disc, gst: q.gst, valid_days: q.valid, terms: q.terms,
      net: Math.round(t.net * 100) / 100, total: Math.round(t.total * 100) / 100,
      ...(m.send ? { status: 'Sent', sent_at: new Date(now) } : {}),
    };
    const id = old ? old.id : await nextQuoteId(session, lead);
    const quote = old ? await repo.updateQuote(id, row, session) : await repo.insertQuote({ id, lead_id: lead.id, status: 'Draft', ...row }, session);
    const currency = await repo.setting('currency', 'INR', session);
    const acts = [L.act(ctx, lead.id, 'quote', `${old ? 'Updated quote ' : 'Created quote '}${id} · ${money(quote.total, currency)}`, new Date(now))];
    if (m.send) acts.push(...(await sendSideEffects(session, lead, id, ctx, now)));
    await repo.addActivities(acts, session);
    return quote;
  });
  return toQuote(saved);
}

/** Mark an existing quote Sent (no edits). */
export async function sendQuote(leadId, qid, ctx) {
  const saved = await tx(async (session) => {
    const lead = await L.writable(session, leadId, ctx.user);
    const old = await repo.findQuote(leadId, qid, session);
    if (!old) throw notFound('Quote');
    const now = Date.now();
    const quote = await repo.updateQuote(qid, { status: 'Sent', sent_at: new Date(now) }, session);
    await repo.addActivities(await sendSideEffects(session, lead, qid, ctx, now), session);
    return quote;
  });
  return toQuote(saved);
}

/** Viewed / Accepted / Declined. Accepting wins the lead at the quote's net value. */
export async function setQuoteStatus(leadId, qid, st, ctx) {
  const saved = await tx(async (session) => {
    const lead = await L.writable(session, leadId, ctx.user);
    const q = await repo.findQuote(leadId, qid, session);
    if (!q) throw notFound('Quote');
    const now = Date.now();
    const col = { Viewed: 'viewed_at', Accepted: 'accepted_at', Declined: 'declined_at' }[st];
    const quote = await repo.updateQuote(qid, { status: st, [col]: new Date(now) }, session);
    const won = st === 'Accepted' && lead.status !== 'Won';
    const acts = [L.act(ctx, lead.id, 'quote', `Quote ${qid} ${st.toLowerCase()}`, new Date(now))];
    if (won) {
      await repo.updateLead(lead.id, { status: 'Won', value: Math.round(Number(q.net) || Number(q.total)) }, session);
      acts.push(L.act(ctx, lead.id, 'status', `Stage: ${lead.status} → Won`, new Date(now + 1)));
    }
    await repo.addActivities(acts, session);
    return quote;
  });
  return { quote: toQuote(saved), leadStatus: (await repo.findLead(leadId)).status };
}

/** Printable HTML for a quote. */
export async function printable(leadId, qid, ctx) {
  const lead = await L.readable(leadId, ctx.user);
  const q = await repo.findQuote(leadId, qid);
  if (!q) throw notFound('Quote');
  const owner = await repo.ownerById(lead.owner_id);
  return printQuote(lead, quoteModel(q), owner ? owner.name : 'Unassigned');
}

export async function listQuotes(leadId, ctx) {
  await L.readable(leadId, ctx.user);
  return (await repo.quotesOf(leadId)).map(toQuote);
}
