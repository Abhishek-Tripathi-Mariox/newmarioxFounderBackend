/**
 * Copying MongoDB documents (partner portal, Founders HQ) into Mariox One collections, keeping `_id`
 * so every ObjectId reference (owner, lead, partner, fileId, updatedBy, by …) stays valid.
 */
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;
const same = (a, b) => EJSON.stringify(a, { relaxed: false }) === EJSON.stringify(b, { relaxed: false });

/** Top-level fields a mongoose schema knows (plus _id / __v / timestamps). */
export function knownFields(model) {
  const top = new Set(['_id', '__v', 'createdAt', 'updatedAt']);
  for (const p of Object.keys(model.schema.paths)) top.add(p.split('.')[0]);
  for (const p of Object.keys(model.schema.nested || {})) top.add(p.split('.')[0]);
  return top;
}

/**
 * Validate a source document against the target model (casting errors, required fields, enums).
 * @returns {string|null} a short reason, or null when valid
 */
export function invalidReason(model, doc) {
  const err = new model(doc).validateSync();
  if (!err) return null;
  return `invalid ${Object.values(err.errors).map((e) => `${e.path}${e.kind ? ` (${e.kind})` : ''}`).join(', ')}`;
}

/**
 * Upsert one document by `filter` (default: its `_id`). A new document keeps the source `_id`; an
 * existing one is replaced (keeping its own `_id`) only when its content differs.
 * @returns {Promise<'inserted'|'updated'|'unchanged'>} (dry run: 'inserted' = would insert, 'updated' = exists)
 */
export async function upsertDoc(collection, doc, { filter = { _id: doc._id }, dryRun }) {
  const existing = await collection.findOne(filter);
  if (dryRun) return existing ? 'updated' : 'inserted';
  if (!existing) {
    await collection.insertOne(doc);
    return 'inserted';
  }
  const { _id, ...rest } = doc;
  const { _id: keep, ...current } = existing;
  if (same(rest, current) && (keep === _id || same(keep, _id))) return 'unchanged';
  await collection.replaceOne({ _id: keep }, rest);
  return 'updated';
}

/** Count into a report row. */
export function tally(row, outcome) {
  row[outcome]++;
}

/** All documents of a source collection, oldest first (by _id). */
export const readAll = (db, name) => db.collection(name).find({}).sort({ _id: 1 }).toArray();
