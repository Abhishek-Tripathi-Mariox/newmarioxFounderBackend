/**
 * Building blocks for the mongoose models in ./models — one model per former Postgres table,
 * collection name = table name, column names unchanged (snake_case). Rules: docs/MONGO.md.
 *
 * Column helpers take the Postgres default as their argument:
 *   text()          nullable, defaults to null
 *   text('')        NOT NULL DEFAULT ''
 *   text(REQUIRED)  NOT NULL without a default
 * `null` is always stored explicitly (never a missing field), so lean reads return the same
 * keys the pg driver returned.
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { nextSeqBlock } from './counters.js';

const { Schema } = mongoose;

// Postgres semantics, applied once for every model:
// - NOT NULL means "not null": '' is a valid value for a required text column.
mongoose.Schema.Types.String.checkRequired((v) => v != null);
// - CHECK constraints (enum / match validators) also hold for updates, not only inserts.
mongoose.set('runValidators', true);
// - Filters, updates and projections may use the PK column name (`id`, `key`, `person_id`) for `_id`.
mongoose.set('translateAliases', true);

/** Marker for NOT NULL columns without a default. */
export const REQUIRED = Symbol('required');

/** Postgres-style ISO calendar day, exactly what the pg DATE parser returned. */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Case-insensitive collation: citext columns and `lower(x) = lower(y)` comparisons. */
export const CASE_INSENSITIVE = Object.freeze({ locale: 'en', strength: 2 });
/** Collation for ORDER BY on human text (names), close to Postgres' en_US ordering. */
export const TEXT_ORDER = Object.freeze({ locale: 'en' });

/** `ILIKE '%text%'` → case-insensitive "contains" condition for a filter. */
export const ilike = (text) => ({ $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' });

function column(base, def) {
  if (def === REQUIRED) return { ...base, required: true };
  if (def === undefined || def === null) return { ...base, default: null };
  return { ...base, required: true, default: def };
}

/** Round to a fixed number of decimals like NUMERIC(p, scale) does on write. */
const roundTo = (scale) => (v) => (v == null || Number.isNaN(Number(v)) ? v : Number(`${Math.round(Number(`${v}e${scale}`))}e-${scale}`));

export const text = (def) => column({ type: String }, def);
export const oneOf = (values, def) => column({ type: String, enum: def === undefined || def === null ? [...values, null] : values }, def);
export const int = (def) => column({ type: Number, set: (v) => (v == null ? v : Math.round(v)) }, def);
export const bool = (def) => column({ type: Boolean }, def);
/** NUMERIC(p, scale) → Number rounded to `scale` decimals. */
export const dec = (scale, def) => column({ type: Number, set: roundTo(scale) }, def);
/** DATE → 'YYYY-MM-DD' string. */
export const day = (def) => column({ type: String, match: DAY_RE }, def);
/** TIMESTAMPTZ → Date. Pass `Date.now` for DEFAULT now(). */
export const ts = (def) => column({ type: Date }, def);
/** text[] → [String] (NOT NULL DEFAULT '{}' everywhere in this schema). */
export const texts = () => ({ type: [String], default: [] });
/** jsonb → Mixed; `def` is a factory so documents never share a default object. */
export const json = (def) => column({ type: Schema.Types.Mixed }, def === undefined || def === REQUIRED ? def : () => structuredClone(def));

/** Primary-key kinds (see docs/MONGO.md "Ids"). */
export const PK = Object.freeze({
  /** Text code (MX-1001, u-ceo …): `_id` holds it, exposed as `id` (or another column name). */
  text: 'text',
  /** gen_random_uuid(): `_id` is a random UUID string. */
  uuid: 'uuid',
  /** bigIncrements: numeric `_id` from the `<table>_id_seq` counter. */
  serial: 'serial',
  /** No usable single-column PK (composite key, or a renameable natural key): ObjectId, hidden from rows. */
  hidden: 'hidden',
});

/**
 * Define a model for a former Postgres table.
 * @param {string} table        collection (= table) name
 * @param {object} fields       column → schema type
 * @param {object} opts
 * @param {string} [opts.pk='text']        one of PK
 * @param {string} [opts.pkColumn='id']    column name the `_id` is exposed as (e.g. 'key', 'person_id')
 * @param {'both'|'created'|false} [opts.stamps='both']  created_at / updated_at maintenance
 * @param {Array<[object, object?]>} [opts.indexes]      [fields, options] pairs
 */
export function defineModel(table, fields, { pk = PK.text, pkColumn = 'id', stamps = 'both', indexes = [] } = {}) {
  const idField = {
    [PK.text]: { _id: { type: String, alias: pkColumn } },
    [PK.uuid]: { _id: { type: String, alias: pkColumn, default: () => randomUUID() } },
    [PK.serial]: { _id: { type: Number, alias: pkColumn } },
    [PK.hidden]: {},
  }[pk];
  if (!idField) throw new Error(`Unknown pk kind "${pk}" for ${table}`);

  const schema = new Schema({ ...idField, ...fields }, {
    collection: table,
    id: false, // no mongoose `id` getter: `id` is the alias of `_id` instead
    versionKey: false,
    minimize: false, // keep empty jsonb objects ({}), like Postgres
    strict: 'throw', // unknown columns are bugs — fail loudly instead of dropping them
    timestamps: stamps === 'both' ? { createdAt: 'created_at', updatedAt: 'updated_at' }
      : stamps === 'created' ? { createdAt: 'created_at', updatedAt: false } : false,
  });
  for (const [spec, options] of indexes) schema.index(spec, options);

  if (pk === PK.serial) {
    const seq = `${table}_id_seq`;
    // Model.insertMany: reserve one block of ids for the rows that don't bring their own.
    // (`_next` only gives access to `docs`: the returned promise ends the hook.)
    schema.pre('insertMany', async function assignSerialIds(_next, docs) {
      const list = Array.isArray(docs) ? docs : [docs];
      const missing = list.filter((d) => d._id == null && d[pkColumn] == null);
      if (!missing.length) return;
      const first = await nextSeqBlock(seq, missing.length);
      missing.forEach((d, i) => { d._id = first + i; });
    });
    // doc.save() / Model.create()
    schema.pre('validate', async function assignSerialId() {
      if (this.isNew && this._id == null) this._id = await nextSeqBlock(seq, 1);
    });
  }

  /** Lean document → the row shape knex returned: `_id` renamed to the PK column (or dropped when hidden). */
  const toRow = (doc) => {
    if (!doc) return doc;
    const { _id, ...rest } = doc;
    return pk === PK.hidden ? rest : { [pkColumn]: _id, ...rest };
  };
  schema.static('toRow', toRow);
  /** Terminal query helper: `Model.find(filter).sort(...).rows()` → plain rows (lean + toRow). */
  schema.query.rows = function rows() {
    return this.lean().transform((res) => (Array.isArray(res) ? res.map(toRow) : toRow(res)));
  };
  /** Insert rows (like `insert(...).returning('*')`) and return them as plain rows. */
  schema.static('insertRows', async function insertRows(rows, session = null) {
    const docs = await this.insertMany(rows, { session });
    return docs.map((d) => toRow(d.toObject()));
  });

  return mongoose.models[table] || mongoose.model(table, schema);
}
