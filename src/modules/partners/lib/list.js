import { searchParams } from './http.js';

/**
 * Server-side list protocol (mariox-saas src/lib/list.ts): ?page=&limit=&q=&sort=&<filter>=
 *   limit   one of PAGE_SIZES (default 25)
 *   q       case-insensitive search over `search` fields (regex-escaped, max 100 characters)
 *   sort    "field" or "-field" from the `sorts` allow-list; `_id: -1` breaks ties
 *   filters each allowed param maps to a condition; a comma means "any of"
 * Without ?page the whole filtered list is returned (max 2000) and `meta` is undefined.
 */
export const PAGE_SIZES = [10, 25, 50, 100];
const MAX_UNPAGED = 2000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Filter: the param's value(s) must equal `field` (optionally cast, e.g. Number). */
export const eq = (field, cast = (v) => v) => (v) => {
  const vals = v.split(',').filter(Boolean).map(cast);
  if (!vals.length) return undefined;
  return { [field]: vals.length === 1 ? vals[0] : { $in: vals } };
};

export function parseList(req, spec) {
  const p = searchParams(req);
  const conditions = [];

  const q = p.get('q')?.trim();
  if (q) {
    const re = new RegExp(escapeRe(q.slice(0, 100)), 'i');
    conditions.push({ $or: spec.search.map((f) => ({ [f]: re })) });
  }
  for (const [param, fn] of Object.entries(spec.filters ?? {})) {
    const v = p.get(param);
    const c = v ? fn(v) : undefined;
    if (c) conditions.push(c);
  }

  const rawSort = p.get('sort') || spec.defaultSort;
  const sortKey = spec.sorts.includes(rawSort.replace(/^-/, '')) ? rawSort : spec.defaultSort;
  const sort = { [sortKey.replace(/^-/, '')]: sortKey.startsWith('-') ? -1 : 1, _id: -1 };

  const limitParam = Number(p.get('limit'));
  return {
    conditions,
    sort,
    paged: p.has('page'),
    page: Math.max(1, Math.floor(Number(p.get('page')) || 1)),
    limit: PAGE_SIZES.includes(limitParam) ? limitParam : 25,
  };
}

/**
 * Run a list query → { items, meta }.
 * @param {import('mongoose').Model} model
 * @param {object} base      conditions always applied (tenant scope)
 * @param {import('express').Request} req
 * @param {{ search: string[], sorts: string[], defaultSort: string, filters?: object }} spec
 * @param {object} [populate] mongoose populate options
 */
export async function runList(model, base, req, spec, populate) {
  const { conditions, sort, paged, page, limit } = parseList(req, spec);
  const filter = conditions.length ? { $and: [base, ...conditions] } : base;

  let query = model.find(filter).sort(sort);
  if (populate) query = query.populate(populate);

  if (!paged) return { items: await query.limit(MAX_UNPAGED).lean(), meta: undefined };

  const [total, items] = await Promise.all([
    model.countDocuments(filter),
    query.skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}
