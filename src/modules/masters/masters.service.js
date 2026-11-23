import { tx } from '../../db/mongo.js';
import { CASE_INSENSITIVE } from '../../db/modelKit.js';
import { Lead, LeadSource, LeadStage, Project, Service, Setting } from '../../db/models/index.js';
import { notFound, unprocessable } from '../../core/errors.js';

/** Stages the app logic depends on — never removable / renameable / movable. */
export const CORE_STAGES = ['New', 'Won', 'Lost'];

const clean = (x) => String(x ?? '').trim().replace(/\s+/g, ' ');
const cleanService = (x) => clean(x).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** A random hue as far as possible from the ones already in use (best of 24 tries) — frontend distinctHue. */
export function distinctHue(used) {
  let best = Math.floor(Math.random() * 360);
  let bestD = -1;
  for (let i = 0; i < 24; i++) {
    const h = Math.floor(Math.random() * 360);
    const d = used.length ? Math.min(...used.map((u) => hueDist(u, h))) : 360;
    if (d > bestD) { best = h; bestD = d; }
  }
  return best;
}

const inUseMsg = (what, name, n, noun = 'lead') => `Can't remove ${what} “${name}” — ${n} ${noun}${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} it`;

/**
 * The three lists share add / rename / move / remove; they differ in collection, wording, name
 * cleaning, how usage is counted and how a rename reaches the documents that use the value
 * (the old ON UPDATE CASCADE foreign keys / text[] columns).
 */
const KINDS = {
  stage: {
    Model: LeadStage, what: 'stage', Label: 'Stage', clean,
    usage: (n, session) => Lead.countDocuments({ status: n }).session(session),
    cascadeRename: (from, to, session) => Lead.updateMany({ status: from }, { status: to }, { session }),
  },
  source: {
    Model: LeadSource, what: 'source', Label: 'Source', clean,
    usage: (n, session) => Lead.countDocuments({ source: n }).session(session),
    cascadeRename: (from, to, session) => Lead.updateMany({ source: from }, { source: to }, { session }),
  },
  service: {
    Model: Service, what: 'service', Label: 'Service', clean: cleanService, noun: 'lead / project',
    usage: async (n, session) => (await Lead.countDocuments({ services: n }).session(session)) + (await Project.countDocuments({ services: n }).session(session)),
    cascadeRename: async (from, to, session) => {
      for (const Model of [Lead, Project]) {
        await Model.updateMany({ services: from }, { $set: { 'services.$[s]': to } }, { arrayFilters: [{ s: from }], session });
      }
    },
  },
};

const stageDto = (r, usage) => ({ name: r.name, hue: r.hue, position: r.position, isCore: r.is_core, usage });
const itemDto = (r, usage) => ({ name: r.name, position: r.position, usage });
const toDto = async (kind, r, session = null) => (kind === 'stage' ? stageDto : itemDto)(r, await KINDS[kind].usage(r.name, session));

const ordered = (kind, session = null) => KINDS[kind].Model.find().sort({ position: 1, name: 1 }).session(session).rows();

export async function list(kind) {
  const out = [];
  for (const r of await ordered(kind)) out.push(await toDto(kind, r));
  return out;
}

async function rowOf(kind, name, session = null) {
  const k = KINDS[kind];
  const r = await k.Model.findOne({ name }).session(session).rows();
  if (!r) throw notFound(k.Label);
  return r;
}

/** Another entry with the same name, ignoring case (`lower(name) = lower(?)`). */
const sameName = (kind, name, session, exceptName) => KINDS[kind].Model
  .findOne(exceptName === undefined ? { name } : { name, $nor: [{ name: exceptName }] })
  .collation(CASE_INSENSITIVE).session(session).rows();

/**
 * Add a value. Blank → rule error; an existing name (case-insensitive) is returned as-is
 * (`created: false`). New stages go just before Won with a hue distinct from the others.
 */
export async function add(kind, raw) {
  const k = KINDS[kind];
  const name = k.clean(raw);
  if (!name) throw unprocessable('Enter a name.');
  return tx(async (session) => {
    const ex = await sameName(kind, name, session);
    if (ex) return { created: false, item: await toDto(kind, ex, session) };
    const rows = await k.Model.find().sort({ position: 1 }).session(session).rows();
    if (kind === 'stage') {
      const won = rows.find((r) => r.name === 'Won');
      const at = won ? won.position : (rows.length ? rows[rows.length - 1].position + 1 : 0);
      await k.Model.updateMany({ position: { $gte: at } }, { $inc: { position: 1 } }, { session });
      const [r] = await k.Model.insertRows([{ name, hue: distinctHue(rows.map((x) => x.hue)), position: at, is_core: false }], session);
      return { created: true, item: stageDto(r, 0) };
    }
    const pos = rows.length ? rows[rows.length - 1].position + 1 : 0;
    const [r] = await k.Model.insertRows([{ name, position: pos }], session);
    return { created: true, item: itemDto(r, 0) };
  });
}

/** Rename and update every document that uses the value (leads.status / leads.source, services arrays). */
export async function rename(kind, from, raw) {
  const k = KINDS[kind];
  const to = k.clean(raw);
  if (!to) throw unprocessable('Enter a name.');
  if (kind === 'stage' && CORE_STAGES.includes(from)) throw unprocessable(`“${from}” is a core stage and can't be renamed.`);
  return tx(async (session) => {
    await rowOf(kind, from, session);
    if (to === from) return to;
    if (await sameName(kind, to, session, from)) throw unprocessable(`A ${k.what} called “${to}” already exists.`);
    await k.Model.updateOne({ name: from }, { name: to }, { session });
    await k.cascadeRename(from, to, session);
    return to;
  });
}

export async function setHue(name, hue) {
  await tx(async (session) => {
    await rowOf('stage', name, session);
    await LeadStage.updateOne({ name }, { hue }, { session });
  });
}

/** PATCH a stage: rename and/or recolour. Returns the stage after the change. */
export async function patchStage(name, body) {
  let cur = name;
  if (body.name !== undefined) cur = await rename('stage', name, body.name);
  if (body.hue !== undefined) await setHue(cur, body.hue);
  if (body.name === undefined && body.hue === undefined) await rowOf('stage', name);
  return (await list('stage')).find((s) => s.name === cur);
}

/**
 * Move one step up (-1) / down (+1). Custom stages move only between New and Won/Lost;
 * core stages don't move. Sources / services move freely (dropdown order).
 */
export async function move(kind, name, dir) {
  const k = KINDS[kind];
  await tx(async (session) => {
    const rows = await ordered(kind, session);
    const i = rows.findIndex((r) => r.name === name);
    if (i < 0) throw notFound(k.Label);
    if (kind === 'stage' && CORE_STAGES.includes(name)) throw unprocessable(`“${name}” is a core stage and can't be moved.`);
    const j = i + dir;
    if (j < 0 || j >= rows.length || (kind === 'stage' && CORE_STAGES.includes(rows[j].name))) return; // already at the edge: no-op like the frontend
    [rows[i], rows[j]] = [rows[j], rows[i]];
    for (let n = 0; n < rows.length; n++) if (rows[n].position !== n) await k.Model.updateOne({ name: rows[n].name }, { position: n }, { session });
  });
  return list(kind);
}

export async function remove(kind, name) {
  const k = KINDS[kind];
  if (kind === 'stage' && CORE_STAGES.includes(name)) throw unprocessable(`“${name}” is a core stage and can't be removed`);
  await tx(async (session) => {
    await rowOf(kind, name, session);
    const n = await k.usage(name, session);
    if (n) throw unprocessable(inUseMsg(k.what, name, n, k.noun));
    if (kind !== 'stage' && (await k.Model.countDocuments().session(session)) <= 1) throw unprocessable(`Keep at least one ${k.what}`);
    await k.Model.deleteOne({ name }, { session });
  });
}

/* ---- settings ---- */
export async function getSettings() {
  const rows = await Setting.find().select('value').rows();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function putSettings(patch) {
  await tx(async (session) => {
    for (const [key, value] of Object.entries(patch)) {
      await Setting.updateOne({ key }, { value }, { upsert: true, session });
    }
  });
  return getSettings();
}
